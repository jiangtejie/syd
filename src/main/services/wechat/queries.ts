import { createHash } from 'node:crypto'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3-multiple-ciphers'
import { openWxDbFile } from './wxDb'
import { locateWeChatDbs } from './dbLocator'
import {
  getMessageTableColumns,
  resolveSessionTableName,
  getRowField,
  toNumber,
  toString,
  type MessageTableColumns
} from './schema'
import {
  decodeMessageContent,
  parseMessageContent,
  parseImageMd5,
  parseImageInfo,
  parsePackedInfoMd5,
  parseVoiceDuration,
  parseVideoMd5,
  parseVideoDuration,
  parseEmojiInfo,
  parseFileInfo,
  parseChatHistory,
  parseQuoteMessage,
  processSummary,
  parseRedEnvelopeSendId,
  parseTransferUsernames
} from './content'
import { resolveOpenimDisplayName } from './weCom'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import type {
  ChatMessage,
  MessageCursor,
  RedEnvelopeStatus,
  SessionSummary
} from '../../../shared/types'

/**
 * 微信读库查询层（自研实现）。
 * 每个查询按需临时打开对应库文件（只读），查询后立即关闭，避免长时间占用句柄。
 */

const CONTACT_TABLE_CANDIDATES = ['contact', 'Contact', 'Friend', 'FriendTable']
const CONTACT_DB_CANDIDATES = ['contact.db', 'contact_new.db', 'friend.db']

/** 递归查找 contact 库（新版微信位于 db_storage/contact/contact.db） */
function findContactDb(dbStoragePath: string): string | null {
  const stack = [dbStoragePath]
  const seen = new Set<string>()
  while (stack.length > 0 && seen.size < 200) {
    const dir = stack.pop()!
    if (seen.has(dir)) continue
    seen.add(dir)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isFile() && CONTACT_DB_CANDIDATES.includes(entry.toLowerCase())) {
        return full
      }
      if (
        st.isDirectory() &&
        entry.toLowerCase() !== 'message' &&
        entry.toLowerCase() !== 'session'
      ) {
        stack.push(full)
      }
    }
  }
  return null
}

/** 递归查找指定名库文件（如 head_image.db） */
function findDbFileByName(dbStoragePath: string, fileName: string): string | null {
  const stack = [dbStoragePath]
  const seen = new Set<string>()
  const target = fileName.toLowerCase()
  while (stack.length > 0 && seen.size < 200) {
    const dir = stack.pop()!
    if (seen.has(dir)) continue
    seen.add(dir)
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = join(dir, entry)
      let st: ReturnType<typeof statSync>
      try {
        st = statSync(full)
      } catch {
        continue
      }
      if (st.isFile() && entry.toLowerCase() === target) return full
      if (
        st.isDirectory() &&
        entry.toLowerCase() !== 'message' &&
        entry.toLowerCase() !== 'session'
      ) {
        stack.push(full)
      }
    }
  }
  return null
}

export interface WxReaderContext {
  dbPath: string
  wxid: string
  hexKey: string
}

/** 会话 id -> 消息表名 hash */
export function messageTableHash(sessionId: string): string {
  return createHash('md5').update(sessionId).digest('hex').toLowerCase()
}

// ── 会话列表 ──

interface SessionRow {
  username: string
  displayName: string
  type: number
  sortTimestamp: number
  lastTimestamp: number
  unreadCount: number
  summary: string
  lastMsgType: number
  isPinned: boolean
  isCollapsed: boolean
  isOfficialAccount: boolean
  isFoldGroup: boolean
  isWeCom: boolean
  isGroup: boolean
}

const OFFICIAL_ACCOUNT_PREFIXES = ['gh_']
const OFFICIAL_FOLDER = '@placeholder_foldgroup'

function classifyUsername(
  username: string
): Pick<SessionRow, 'isOfficialAccount' | 'isFoldGroup' | 'isWeCom' | 'isGroup'> {
  const u = username || ''
  return {
    isOfficialAccount: OFFICIAL_ACCOUNT_PREFIXES.some((p) => u.startsWith(p)),
    isFoldGroup: u === OFFICIAL_FOLDER,
    isWeCom: u.includes('@openim'),
    isGroup: u.includes('@chatroom')
  }
}

/** 系统/服务号会话过滤（参考 CipherTalk shouldKeepSession）：这些不是真实聊天，不应进会话列表 */
const SESSION_EXCLUDE_PREFIXES = [
  'weixin',
  'qqmail',
  'fmessage',
  'medianote',
  'floatbottle',
  'newsapp',
  'brandservicesessionholder',
  'notifymessage',
  'opencustomerservicemsg',
  'notification_messages',
  'userexperience_alarm'
]

function shouldKeepSession(username: string): boolean {
  if (!username) return false
  if (username.startsWith('gh_')) return true // 公众号保留
  for (const prefix of SESSION_EXCLUDE_PREFIXES) {
    if (username === prefix || username.startsWith(prefix)) return false
  }
  if (username.includes('@kefu.openim')) return false // 微信客服
  if (username.includes('service_')) return false
  return true
}

function rowToSession(row: Record<string, any>): SessionRow {
  const username = toString(getRowField(row, ['username', 'user_name', 'userName']))
  const sortTs = toMs(toNumber(getRowField(row, ['sort_timestamp', 'sortTimestamp', 'sort_time'])))
  const lastTs = toMs(toNumber(getRowField(row, ['last_timestamp', 'lastTimestamp']), sortTs))
  const lastMsgType = toNumber(getRowField(row, ['last_msg_type', 'lastMsgType']), 1)
  const cls = classifyUsername(username)
  return {
    username,
    displayName: cls.isFoldGroup ? '折叠的聊天' : username,
    type: toNumber(getRowField(row, ['type'])),
    sortTimestamp: sortTs,
    lastTimestamp: lastTs,
    unreadCount: toNumber(getRowField(row, ['unread_count', 'unreadCount'])),
    summary: processSummary(
      toString(getRowField(row, ['summary', 'digest', 'message'])),
      lastMsgType
    ),
    lastMsgType,
    isPinned: false,
    isCollapsed: false,
    ...cls
  }
}

/** 微信时间戳统一为毫秒：秒级（10 位）×1000，毫秒级（13 位）原样。渲染端一律用 new Date(ms) */
export function toMs(ts: number): number {
  if (!ts || ts <= 0) return 0
  // 秒级时间戳 < 1e12（约 2001-09 之前不可能是毫秒），据此判定单位
  return ts < 1e12 ? ts * 1000 : ts
}

/** 会话列表（按 sort_timestamp 倒序），enrich 联系人备注/头像/置顶/折叠 */
export function listSessions(ctx: WxReaderContext): {
  ok: boolean
  sessions?: SessionSummary[]
  error?: string
} {
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return { ok: false, error: '未找到微信数据目录' }
    if (!paths.sessionDbFile) return { ok: false, error: '未找到 session.db（会话库）' }

    const opened = openWxDbFile(paths.sessionDbFile, ctx.hexKey)
    if (!opened.db) return { ok: false, error: opened.error }
    const db = opened.db
    try {
      const tableName = resolveSessionTableName(db)
      if (!tableName) return { ok: false, error: '会话表中未找到 SessionTable/Session' }

      const rows = db
        .prepare(`SELECT * FROM ${tableName} ORDER BY sort_timestamp DESC`)
        .all() as Record<string, any>[]
      const sessions: SessionSummary[] = rows
        .map((r) => {
          const s = rowToSession(r)
          return {
            ...s,
            displayName: s.displayName,
            isPinned: s.isPinned,
            isCollapsed: s.isCollapsed
          }
        })
        .filter((s) => shouldKeepSession(s.username))
      return { ok: true, sessions }
    } finally {
      db.close()
    }
  } catch (e: any) {
    return { ok: false, error: `读取会话列表失败: ${e?.message || String(e)}` }
  }
}

/** 用 contact 库 enrich 会话（备注名/头像/置顶/折叠标记） */
export function enrichSessionsWithContacts(
  sessions: SessionSummary[],
  ctx: WxReaderContext
): SessionSummary[] {
  if (sessions.length === 0) return sessions
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return sessions
    const contactFile = findContactDb(paths.dbStoragePath)
    if (!contactFile) return sessions

    const opened = openWxDbFile(contactFile, ctx.hexKey)
    if (!opened.db) return sessions
    const db = opened.db
    try {
      let contactTable: string | null = null
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
      const names = new Set(tables.map((t) => t.name))
      for (const cand of CONTACT_TABLE_CANDIDATES) {
        if (names.has(cand)) {
          contactTable = cand
          break
        }
      }
      if (!contactTable) return sessions

      const usernames = Array.from(new Set(sessions.map((s) => s.username).filter(Boolean)))
      if (usernames.length === 0) return sessions
      const contactMap = queryContactsByUsernames(db, contactTable, usernames)

      for (const session of sessions) {
        const contact = contactMap.get(session.username)
        if (!contact) continue
        const remark = toString(getRowField(contact, ['remark']))
        const nick = toString(getRowField(contact, ['nick_name', 'nickname']))
        const alias = toString(getRowField(contact, ['alias', 'alias_name']))
        session.remark = remark
        session.nickname = nick
        session.alias = alias
        if (!session.isFoldGroup) {
          session.displayName = remark || nick || alias || session.displayName || session.username
        }
        session.avatarUrl = pickAvatarUrl(contact)
        const flag = toNumber(contact.flag)
        if (flag & 0x800) session.isPinned = true
        if (flag & 0x10000000) session.isCollapsed = true
      }
      return sessions
    } finally {
      db.close()
    }
  } catch {
    return sessions
  }
}

/**
 * 批量解析联系人展示名（备注 > 昵称 > alias），查不到/库不可读时不在结果中。
 * 供「跟进人」等按 username 落库后的展示回显；调用方对缺失项降级显示 username。
 */
export function queryContactDisplayNames(
  ctx: WxReaderContext,
  usernames: string[]
): Record<string, string> {
  const want = Array.from(new Set((usernames ?? []).map((u) => toString(u).trim()).filter(Boolean)))
  const out: Record<string, string> = {}
  if (want.length === 0) return out
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return out
    const contactFile = findContactDb(paths.dbStoragePath)
    if (!contactFile) return out
    const opened = openWxDbFile(contactFile, ctx.hexKey)
    if (!opened.db) return out
    const db = opened.db
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
      const names = new Set(tables.map((t) => t.name))
      let contactTable: string | null = null
      for (const cand of CONTACT_TABLE_CANDIDATES) {
        if (names.has(cand)) {
          contactTable = cand
          break
        }
      }
      if (!contactTable) return out
      const contactMap = queryContactsByUsernames(db, contactTable, want)
      for (const u of want) {
        const contact = contactMap.get(u)
        if (!contact) continue
        const name =
          toString(getRowField(contact, ['remark'])) ||
          toString(getRowField(contact, ['nick_name', 'nickname'])) ||
          toString(getRowField(contact, ['alias', 'alias_name']))
        if (name) out[u] = name
      }
    } finally {
      db.close()
    }
  } catch {
    /* 联系人库不可读/版本差异：返回空对象，由调用方降级 */
  }
  return out
}

/** keyset 时间倒序比较：a 是否比 b 新（对齐 listMessages 的分页排序） */
function cursorNewerThan(
  a: { sortSeq: number; createTime: number; localId: number },
  b: { sortSeq: number; createTime: number; localId: number }
): boolean {
  if (a.sortSeq !== b.sortSeq) return a.sortSeq > b.sortSeq
  if (a.createTime !== b.createTime) return a.createTime > b.createTime
  return a.localId > b.localId
}

interface LastSenderProbe {
  session: SessionSummary
  cursor: { sortSeq: number; createTime: number; localId: number } | null
  row: Record<string, any> | null
  cols: MessageTableColumns | null
  nameId: NameIdMap | null
}

/**
 * 给"有未读的可跟进会话"标注 lastMsgIsSend（最后一条是否本人发出）。
 * 供前端把"最后一条是自己发的"会话从待回复队列剔除（微信未读可能尚未清零）。
 * 逐库打开消息文件，只取各目标表最新一行做发送人判定；找不到消息库/表时保持 undefined（未知，不误剔）。
 */
export function annotateUnreadLastSender(sessions: SessionSummary[], ctx: WxReaderContext): void {
  const candidates = sessions.filter(
    (s) => s.unreadCount > 0 && !s.isOfficialAccount && !s.isFoldGroup && !s.isWeCom
  )
  if (candidates.length === 0) return
  const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
  if (!paths.dbStoragePath || paths.msgDbFiles.length === 0) return

  const probes = new Map<string, LastSenderProbe>()
  for (const c of candidates) {
    probes.set(messageTableHash(c.username), {
      session: c,
      cursor: null,
      row: null,
      cols: null,
      nameId: null
    })
  }

  for (const file of paths.msgDbFiles) {
    const opened = openWxDbFile(file, ctx.hexKey)
    if (!opened.db) continue
    const db = opened.db
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'")
        .all() as { name: string }[]
      const nameId = loadNameIdMap(db, ctx.wxid)
      for (const t of tables) {
        const hash = t.name.toLowerCase().match(/^msg_([0-9a-f]{32})$/)
        if (!hash || !probes.has(hash[1])) continue
        const cols = getMessageTableColumns(db, t.name)
        // 无法判定发送人的表（无 sender/real_sender_id/is_send）跳过
        if (!cols.senderColumn && !cols.hasRealSenderId && !cols.hasIsSend) continue
        const row = db
          .prepare(
            `SELECT * FROM "${t.name}" ORDER BY sort_seq DESC, create_time DESC, local_id DESC LIMIT 1`
          )
          .get() as Record<string, any> | undefined
        if (!row) continue
        const probe = probes.get(hash[1])!
        const cursor = rawMessageCursor(row)
        if (!probe.cursor || cursorNewerThan(cursor, probe.cursor)) {
          probe.cursor = cursor
          probe.row = row
          probe.cols = cols
          probe.nameId = nameId
        }
      }
    } catch {
      /* 单个消息库读取失败则跳过 */
    } finally {
      db.close()
    }
  }

  for (const probe of probes.values()) {
    if (!probe.row || !probe.cols || !probe.nameId) continue
    const sender = resolveRowSender(probe.row, probe.cols, probe.nameId)
    probe.session.lastMsgIsSend = resolveRowIsSend(
      probe.row,
      probe.cols,
      probe.nameId,
      ctx.wxid,
      sender
    )
  }
}

/** 按 username 批量查 contact 行（每 400 个一批），返回 username -> 行 */
function queryContactsByUsernames(
  db: Database.Database,
  contactTable: string,
  usernames: string[]
): Map<string, Record<string, any>> {
  const map = new Map<string, Record<string, any>>()
  for (let i = 0; i < usernames.length; i += 400) {
    const batch = usernames.slice(i, i + 400)
    const placeholders = batch.map(() => '?').join(',')
    const rows = db
      .prepare(`SELECT * FROM ${contactTable} WHERE username IN (${placeholders})`)
      .all(...batch) as Record<string, any>[]
    for (const r of rows) map.set(toString(r.username), r)
  }
  return map
}

/** 从 contact 行取头像 URL（big 优先、small 兜底） */
function pickAvatarUrl(contact: Record<string, any>): string | undefined {
  // 逐个字段取第一个非空 URL：群头像仅存于 small_head_url（big_head_url 为空串），
  // 不能只取第一个候选就返回（空串会拦住 small_head_url）
  for (const field of ['big_head_url', 'small_head_url', 'avatar_url']) {
    const v = toString(getRowField(contact, [field]))
    if (v) return v
  }
  return undefined
}

/** 从 contact 行取显示名（remark > nick > alias） */
function pickDisplayName(contact: Record<string, any>): string {
  return (
    toString(getRowField(contact, ['remark'])) ||
    toString(getRowField(contact, ['nick_name', 'nickname'])) ||
    toString(getRowField(contact, ['alias', 'alias_name']))
  )
}

// ── 消息读取 ──

/** 微信 4.x Msg 表无 is_send 列，"是否我发的"= real_sender_id 是否等于我在 Name2Id 的 rowid */
interface NameIdMap {
  /** rowid -> user_name (wxid) */
  idToName: Map<number, string>
  /** 我的 rowid（user_name == 当前 wxid） */
  myRowId: number | null
}

/** 清洗账号目录名 wxid：`wxid_xxx_7e0b`（带实例后缀）→ `wxid_xxx`（对齐 CipherTalk cleanAccountDirName 的 wxid 分支） */
function cleanWxid(wxid: string): string {
  const t = (wxid || '').trim()
  if (!t) return t
  if (t.toLowerCase().startsWith('wxid_')) {
    const m = t.match(/^(wxid_[a-zA-Z0-9]+)/i)
    if (m) return m[1]
  }
  return t
}

/**
 * 账号目录名完整清洗（对齐 CipherTalk cleanAccountDirName）：
 * 额外支持自定义微信号目录 `xxx_yyyy`（4 位字母数字后缀）→ `xxx`。
 * 仅用于当前登录账号身份（Name2Id/头像自匹配），不用于普通联系人 username，
 * 避免把形如 `tom_2020` 的对方自定义微信号误删后缀。
 */
function cleanAccountDirWxid(wxid: string): string {
  const t = cleanWxid(wxid)
  if (!t || t.toLowerCase().startsWith('wxid_')) return t
  const m = t.match(/^(.+)_([a-zA-Z0-9]{4})$/)
  return m ? m[1] : t
}

/**
 * 发送人是否为自己（is_send 归一化兜底）：sender 与 myWxid 做 wxid_ 实例后缀互通匹配。
 * 仅剥离 `wxid_xxx_yyyy` 的实例后缀，不剥离自定义微信号 `tom_2020` 的 4 位后缀，
 * 避免把形如 `tom_abcd` 的对方微信号误判为自己。
 */
export function isOwnSender(sender: string | null, myWxid: string): boolean {
  if (!sender) return false
  if (sender === myWxid) return true
  const s = cleanWxid(sender)
  const m = cleanWxid(myWxid)
  return s !== '' && s === m
}

export function loadNameIdMap(db: Database.Database, myWxid: string): NameIdMap {
  const idToName = new Map<number, string>()
  let myRowId: number | null = null
  // Name2Id 里自己可能是原始 wxid 或清洗后的 wxid（账号目录带实例后缀/自定义微信号后缀时）
  const cleaned = cleanAccountDirWxid(myWxid)
  try {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'")
      .all()
    if (tables.length === 0) return { idToName, myRowId }
    const rows = db.prepare('SELECT rowid, user_name FROM Name2Id').all() as {
      rowid: number
      user_name: string
    }[]
    for (const r of rows) {
      const name = toString(r.user_name)
      idToName.set(toNumber(r.rowid), name)
      if (name === myWxid || (cleaned !== myWxid && name === cleaned)) myRowId = toNumber(r.rowid)
    }
  } catch {
    /* Name2Id 不可读时保持空映射 */
  }
  return { idToName, myRowId }
}

/** 解析消息发送人：real_sender_id → Name2Id.user_name（真实 wxid）；无则回退 sender 列 */
function resolveRowSender(
  row: Record<string, any>,
  cols: MessageTableColumns,
  nameId: NameIdMap
): { realSenderId: number; senderUsername: string | null } {
  const realSenderId = toNumber(getRowField(row, ['real_sender_id', 'realSenderId']), -1)
  let senderUsername: string | null =
    realSenderId >= 0 ? nameId.idToName.get(realSenderId) || null : null
  if (!senderUsername) {
    senderUsername = toString(getRowField(row, [cols.senderColumn || 'sender'])) || null
  }
  return { realSenderId, senderUsername }
}

/**
 * 消息是否本人发出（对齐 CipherTalk 三重判定）：
 * 1) Name2Id 命中：real_sender_id == 我的 rowid（权威）
 * 2) 无 Name2Id：发送人 wxid 与 myWxid 归一化匹配
 * 3) 兜底：is_send 列（旧版兼容）
 */
function resolveRowIsSend(
  row: Record<string, any>,
  cols: MessageTableColumns,
  nameId: NameIdMap,
  myWxid: string,
  sender?: { realSenderId: number; senderUsername: string | null }
): boolean {
  const s = sender ?? resolveRowSender(row, cols, nameId)
  if (nameId.myRowId !== null && s.realSenderId >= 0) {
    return s.realSenderId === nameId.myRowId
  }
  if (isOwnSender(s.senderUsername, myWxid)) return true
  return toNumber(getRowField(row, ['is_send', 'isSend', 'is_sender']), 0) === 1
}

function rowToMessage(
  row: Record<string, any>,
  cols: MessageTableColumns,
  nameId: NameIdMap,
  isGroup: boolean,
  myWxid: string
): ChatMessage {
  const content = decodeMessageContent(getRowField(row, [cols.contentColumn || 'message_content']))
  const localType = toNumber(getRowField(row, ['local_type', 'localType', 'type']), 1)

  const sender = resolveRowSender(row, cols, nameId)
  const senderUsername = sender.senderUsername
  const isSend = resolveRowIsSend(row, cols, nameId, myWxid, sender)

  const parsed = parseMessageContent(content, localType)
  // 图片文件名 md5 优先取 packed_info_data（本地 .dat 命名），XML 的 md5 是 CDN md5 对不上本地文件
  const imageMd5 =
    parsePackedInfoMd5(getRowField(row, ['packed_info_data', 'packedInfoData'])) ||
    parseImageMd5(content)
  const imageInfo = localType === 3 ? parseImageInfo(content) : {}
  const isLivePhoto = imageInfo.isLivePhoto
  const voiceDuration = parseVoiceDuration(content)
  // 视频文件名 md5 同图片：真实文件名存 packed_info_data，XML 里只有 CDN 信息
  const videoMd5 =
    localType === 43
      ? parsePackedInfoMd5(getRowField(row, ['packed_info_data', 'packedInfoData'])) ||
        parseVideoMd5(content)
      : undefined
  const videoDuration = localType === 43 ? parseVideoDuration(content) : undefined
  const emojiInfo = localType === 47 ? parseEmojiInfo(content) : {}
  const fileInfo = parseFileInfo(content)
  const chatRecordList = localType === 49 ? parseChatHistory(content) : undefined
  // 红包 sendId（type 49/2001），供渲染端匹配本地领取状态；非红包消息返回 undefined
  const redEnvelopeSendId = localType === 49 ? parseRedEnvelopeSendId(content) : undefined
  // 转账消息（49/2000）付款/收款方 username
  const transfer =
    localType === 49 && content.includes('payer_username') ? parseTransferUsernames(content) : {}

  // 引用消息：localType 244813135921（微信 4.x 专属）或 49 型内嵌 refermsg
  let quotedContent: string | undefined
  let quotedSender: string | undefined
  let quotedImageMd5: string | undefined
  let quotedEmojiMd5: string | undefined
  let quotedEmojiCdnUrl: string | undefined
  if (localType === 244813135921 || content.includes('<refermsg>')) {
    const quote = parseQuoteMessage(content)
    quotedContent = quote.content
    quotedSender = quote.sender
    quotedImageMd5 = quote.imageMd5
    quotedEmojiMd5 = quote.emojiMd5
    quotedEmojiCdnUrl = quote.emojiCdnUrl
  }

  return {
    localId: toNumber(getRowField(row, ['local_id', 'localId'])),
    serverId: toString(getRowField(row, ['server_id', 'serverId'])),
    serverSeq: toNumber(getRowField(row, ['server_seq', 'serverSeq'])),
    localType,
    createTime: toMs(toNumber(getRowField(row, ['create_time', 'createTime', 'timestamp']))),
    sortSeq: toNumber(getRowField(row, ['sort_seq', 'sortSeq'])),
    isSend,
    senderUsername,
    isGroup,
    parsedContent: parsed,
    rawContent: content,
    imageMd5,
    isLivePhoto,
    voiceDuration,
    videoMd5,
    videoDuration,
    emojiCdnUrl: emojiInfo.cdnUrl,
    emojiMd5: emojiInfo.md5,
    productId: emojiInfo.productId,
    fileName: fileInfo.fileName,
    fileSize: fileInfo.fileSize,
    fileExt: fileInfo.fileExt,
    fileMd5: fileInfo.fileMd5,
    chatRecordList,
    redEnvelopeSendId,
    transferPayerUsername: transfer.payerUsername,
    transferReceiverUsername: transfer.receiverUsername,
    quotedContent,
    quotedSender,
    quotedImageMd5,
    quotedEmojiMd5,
    quotedEmojiCdnUrl
  }
}

/** 消息 identity：跨库去重 key（serverId 优先，否则 localId+sortSeq+createTime 组合） */
function messageDedupKey(m: ChatMessage): string {
  return m.serverId ? `s:${m.serverId}` : `l:${m.localId}:${m.sortSeq}:${m.createTime}`
}

/** 从原始行取 keyset 游标（库原始字段，未转 ms） */
function rawMessageCursor(row: Record<string, any>): MessageCursor {
  return {
    sortSeq: toNumber(getRowField(row, ['sort_seq', 'sortSeq'])),
    createTime: toNumber(getRowField(row, ['create_time', 'createTime', 'timestamp'])),
    localId: toNumber(getRowField(row, ['local_id', 'localId']))
  }
}

interface MsgWithCursor {
  msg: ChatMessage
  cursor: MessageCursor
}

/**
 * 读取某会话消息（跨多个消息库合并，keyset 分页）。
 * before 为空取最新一页；否则按游标取"更早的一页"。返回 nextCursor 供继续向前翻页。
 */
export function listMessages(
  ctx: WxReaderContext,
  sessionId: string,
  limit = 50,
  before?: MessageCursor
): {
  ok: boolean
  messages?: ChatMessage[]
  hasMore?: boolean
  nextCursor?: MessageCursor
  error?: string
} {
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return { ok: false, error: '未找到微信数据目录' }
    if (paths.msgDbFiles.length === 0) return { ok: false, error: '未找到消息库文件' }

    const targetHash = messageTableHash(sessionId)
    const isGroup = sessionId.includes('@chatroom')
    const all: MsgWithCursor[] = []
    const fetchCount = limit + 1
    let anyDbHasMore = false

    for (const file of paths.msgDbFiles) {
      const opened = openWxDbFile(file, ctx.hexKey)
      if (!opened.db) continue
      const db = opened.db
      try {
        const nameId = loadNameIdMap(db, ctx.wxid)
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'")
          .all() as { name: string }[]
        for (const t of tables) {
          const hash = t.name.toLowerCase().match(/^msg_([0-9a-f]{32})$/)
          if (!hash || hash[1] !== targetHash) continue
          const cols = getMessageTableColumns(db, t.name)
          if (!cols.contentColumn && !cols.hasIsSend) continue

          const rows = (
            before
              ? db
                  .prepare(
                    `SELECT * FROM "${t.name}" WHERE (sort_seq < ?) OR (sort_seq = ? AND create_time < ?) OR (sort_seq = ? AND create_time = ? AND local_id < ?) ORDER BY sort_seq DESC, create_time DESC, local_id DESC LIMIT ?`
                  )
                  .all(
                    before.sortSeq,
                    before.sortSeq,
                    before.createTime,
                    before.sortSeq,
                    before.createTime,
                    before.localId,
                    fetchCount
                  )
              : db
                  .prepare(
                    `SELECT * FROM "${t.name}" ORDER BY sort_seq DESC, create_time DESC, local_id DESC LIMIT ?`
                  )
                  .all(fetchCount)
          ) as Record<string, any>[]
          if (rows.length >= fetchCount) anyDbHasMore = true
          for (const r of rows) {
            all.push({
              msg: rowToMessage(r, cols, nameId, isGroup, ctx.wxid),
              cursor: rawMessageCursor(r)
            })
          }
        }
      } finally {
        db.close()
      }
    }

    // 跨库合并：按游标倒序；同一条消息可能散在多个历史分片库，按 identity 去重
    const seen = new Set<string>()
    const deduped: MsgWithCursor[] = []
    all
      .sort(
        (a, b) =>
          b.cursor.sortSeq - a.cursor.sortSeq ||
          b.cursor.createTime - a.cursor.createTime ||
          b.cursor.localId - a.cursor.localId
      )
      .forEach((item) => {
        const key = messageDedupKey(item.msg)
        if (seen.has(key)) return
        seen.add(key)
        deduped.push(item)
      })

    const hasMore = deduped.length > limit || anyDbHasMore
    const pageItems = deduped.slice(0, limit)
    const nextCursor =
      hasMore && pageItems.length > 0 ? pageItems[pageItems.length - 1].cursor : undefined
    const page = pageItems.map((it) => it.msg).reverse()
    // enrich 发送人昵称/头像/群昵称/企微名/转账双方名（群消息关键）
    enrichMessagesWithSenders(page, ctx, sessionId)
    return { ok: true, messages: page, hasMore, nextCursor }
  } catch (e: any) {
    return { ok: false, error: `读取消息失败: ${e?.message || String(e)}` }
  }
}

/** 增量读取：读取某 sortSeq 之后的全部消息（供 T5 轮询） */
export function listMessagesSince(
  ctx: WxReaderContext,
  sessionId: string,
  sinceSortSeq: number,
  limit = 200
): { ok: boolean; messages?: ChatMessage[]; error?: string } {
  const result = listMessages(ctx, sessionId, limit)
  if (!result.ok || !result.messages) return { ok: false, error: result.error }
  const filtered = result.messages.filter((m) => m.sortSeq > sinceSortSeq)
  return { ok: true, messages: filtered }
}

/**
 * 会话内红包的本地状态（general.db redEnvelopeTable）。
 * 只记录「我领没领 / 红包状态」，本地没有金额与领取人列表（对齐 CipherTalk redEnvelopeQueries）。
 * 老版本无此表 / 库未就绪时返回空数组（不报错）。
 */
export function getRedEnvelopeStatuses(
  ctx: WxReaderContext,
  sessionId: string
): { ok: boolean; statuses?: RedEnvelopeStatus[]; error?: string } {
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return { ok: true, statuses: [] }
    const generalFile = findDbFileByName(paths.dbStoragePath, 'general.db')
    if (!generalFile) return { ok: true, statuses: [] }

    const opened = openWxDbFile(generalFile, ctx.hexKey)
    if (!opened.db) return { ok: true, statuses: [] }
    const db = opened.db
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='redEnvelopeTable'")
        .all()
      if (tables.length === 0) return { ok: true, statuses: [] }

      const rows = db
        .prepare(
          'SELECT send_id, sender_user_name, hb_status, hb_type, receive_status FROM redEnvelopeTable WHERE session_name = ?'
        )
        .all(sessionId) as Record<string, any>[]
      const statuses: RedEnvelopeStatus[] = rows
        .filter((r) => getRowField(r, ['send_id', 'sendId']))
        .map((r) => ({
          sendId: toString(getRowField(r, ['send_id', 'sendId'])),
          senderUsername: toString(getRowField(r, ['sender_user_name', 'senderUsername'])),
          hbStatus: toNumber(getRowField(r, ['hb_status', 'hbStatus'])),
          hbType: toNumber(getRowField(r, ['hb_type', 'hbType'])),
          receiveStatus: toNumber(getRowField(r, ['receive_status', 'receiveStatus']))
        }))
      return { ok: true, statuses }
    } finally {
      db.close()
    }
  } catch {
    // 老版本微信没有这张表 / 库未就绪：当作没有状态
    return { ok: true, statuses: [] }
  }
}

/** 进程级群昵称缓存（key = wxid|chatroomId，TTL 10 分钟，容量超限整体重建） */
const groupNickCache = new Map<string, { at: number; map: Map<string, string> }>()
const GROUP_NICK_TTL_MS = 10 * 60_000
const GROUP_NICK_MAX = 100

/** 解析群成员名单 XML（room_data：<member><username>…<displayName>…），username -> 群昵称 */
function extractRoomMemberNames(roomData: string): Map<string, string> {
  const map = new Map<string, string>()
  const re =
    /<member>[\s\S]*?<username>(.*?)<\/username>[\s\S]*?<displayName>(.*?)<\/displayName>[\s\S]*?<\/member>/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(roomData)) !== null) {
    const u = (m[1] || '').trim()
    const n = (m[2] || '').trim()
    if (u && n && n !== u) map.set(u, n)
  }
  return map
}

/**
 * 读取群成员群昵称映射（contact.db 中表名含 chatroom 的表，如 chatroom_info；
 * 移植 CipherTalk resolveTransferDisplayNames 的 room_data 解析）。
 * 兼容表名/列名差异，任一步失败静默返回空 Map。
 */
function loadGroupNicknames(ctx: WxReaderContext, chatroomId: string): Map<string, string> {
  const cacheKey = `${ctx.wxid}|${chatroomId}`
  const hit = groupNickCache.get(cacheKey)
  if (hit && Date.now() - hit.at < GROUP_NICK_TTL_MS) return hit.map
  if (groupNickCache.size >= GROUP_NICK_MAX) groupNickCache.clear()

  const empty = new Map<string, string>()
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return empty
    const contactFile = findContactDb(paths.dbStoragePath)
    if (!contactFile) return empty
    const opened = openWxDbFile(contactFile, ctx.hexKey)
    if (!opened.db) return empty
    const db = opened.db
    try {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
      const out = new Map<string, string>()
      for (const t of tables) {
        if (!/chatroom/i.test(t.name)) continue
        try {
          const cols = (db.prepare(`PRAGMA table_info(${t.name})`).all() as { name: string }[]).map(
            (c) => c.name
          )
          const roomKeyCol = cols.find((c) => /chatroom_name|room_name|username/i.test(c)) ?? null
          const dataCol = cols.find((c) => /room_data|ext_buffer|member_list|member/i.test(c))
          if (!roomKeyCol || !dataCol) continue
          const rows = db
            .prepare(`SELECT ${roomKeyCol} AS k, ${dataCol} AS d FROM ${t.name}`)
            .all() as Array<{ k?: string; d?: unknown }>
          for (const r of rows) {
            if (r.k !== chatroomId) continue // 只取当前群那一行（多数表一行一群）
            const d = r.d
            const data = Buffer.isBuffer(d) ? d.toString('utf-8') : typeof d === 'string' ? d : ''
            if (data.includes('<member>')) {
              for (const [u, n] of extractRoomMemberNames(data)) out.set(u, n)
            }
          }
        } catch {
          /* 表结构不适配，跳过 */
        }
      }
      groupNickCache.set(cacheKey, { at: Date.now(), map: out })
      return out
    } finally {
      db.close()
    }
  } catch {
    return empty
  }
}

/** 我方身份变体集合（原 wxid + 清洗后），用于匹配 room_data 里的自己 */
function myWxidVariants(wxid: string): string[] {
  const clean = cleanAccountDirWxid(wxid)
  return clean && clean !== wxid ? [wxid, clean] : [wxid]
}

/** 转账参与方显示名：己方 → 群昵称或「我」；群昵称 > 备注 > 昵称 > alias > 原样（移植 CipherTalk resolveName） */
function resolvePartyName(
  username: string | undefined,
  groupNick: Map<string, string>,
  contactMap: Map<string, Record<string, any>>,
  myVariants: string[]
): string | undefined {
  if (!username) return undefined
  if (myVariants.includes(username)) return '我'
  const groupName =
    groupNick.get(username) ||
    (username.startsWith('wxid_') ? groupNick.get(cleanWxid(username)) : undefined)
  if (groupName) return groupName
  const contact = contactMap.get(username)
  if (contact) {
    const name = pickDisplayName(contact)
    if (name) return name
  }
  return undefined
}

/**
 * 用 contact 库 enrich 消息（发送人昵称/头像 + 群昵称 + 企微展示名 + 转账双方名）。
 * 群消息发送人名优先级：群昵称(chatroom_info room_data) > 联系人备注/昵称/alias
 *   > 企微 openim 展示名(extra_buffer/openim_wording)。
 * sessionId 为消息所属会话（群时为群 id，用于加载该群群昵称映射）。
 * 自己发的消息不 enrich（渲染端用"我"的占位）。
 */
export function enrichMessagesWithSenders(
  messages: ChatMessage[],
  ctx: WxReaderContext,
  sessionId?: string
): ChatMessage[] {
  if (messages.length === 0) return messages
  const isGroup = !!sessionId && sessionId.includes('@chatroom')
  // 只处理有真实发送人 wxid 的接收消息
  const senderIds = Array.from(
    new Set(
      messages.filter((m) => !m.isSend && m.senderUsername).map((m) => m.senderUsername as string)
    )
  )
  // 转账消息里的参与方也纳入联系人查询
  for (const m of messages) {
    if (m.transferPayerUsername) senderIds.push(m.transferPayerUsername)
    if (m.transferReceiverUsername) senderIds.push(m.transferReceiverUsername)
  }
  if (senderIds.length === 0) return messages

  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return messages
    const contactFile = findContactDb(paths.dbStoragePath)
    if (!contactFile) return messages

    const opened = openWxDbFile(contactFile, ctx.hexKey)
    if (!opened.db) return messages
    const db = opened.db
    try {
      let contactTable: string | null = null
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as {
        name: string
      }[]
      const names = new Set(tables.map((t) => t.name))
      for (const cand of CONTACT_TABLE_CANDIDATES) {
        if (names.has(cand)) {
          contactTable = cand
          break
        }
      }
      if (!contactTable) return messages

      const contactMap = queryContactsByUsernames(db, contactTable, senderIds)
      const myVariants = myWxidVariants(ctx.wxid)
      // 团队客服成员（全局手动标识）：消息发送人标记 senderIsTeam，供展示与分析判定
      const teamSet = getTeamUsernamesCached(ctx.wxid)
      for (const m of messages) {
        if (m.isSend || !m.senderUsername) continue
        if (teamSet.has(m.senderUsername)) m.senderIsTeam = true
      }
      // 群昵称映射（同会话一次性加载，缓存 10 分钟）
      const groupNick = isGroup ? loadGroupNicknames(ctx, sessionId!) : undefined

      const missingOpenim: string[] = []
      for (const m of messages) {
        if (m.isSend || !m.senderUsername) continue
        const username = m.senderUsername
        const contact = contactMap.get(username)
        const contactName = contact ? pickDisplayName(contact) : ''
        const isWeCom = username.includes('@openim') && !username.includes('@kefu.openim')
        let name = ''
        // 群昵称优先（企微成员在群内通常有 displayName）
        if (groupNick) {
          name =
            groupNick.get(username) ||
            (username.startsWith('wxid_') ? groupNick.get(cleanWxid(username)) || '' : '')
        }
        // 其次联系人备注/昵称；企微用户无常规名时再尝试 openim 展示名
        if (!name) name = contactName
        if (!name && isWeCom && contact?.extra_buffer) {
          name =
            resolveOpenimDisplayName(db, contact.extra_buffer, [
              toString(contact.remark),
              toString(contact.nick_name),
              toString(contact.nickname),
              toString(contact.alias),
              username
            ]) || ''
        }
        if (!name && contact) {
          if (isWeCom && missingOpenim.length < 5) missingOpenim.push(username)
        }
        // 不再把原始 id 当作昵称（气泡/分析链路仅在确实有名时展示）
        if (name) m.senderNickname = name
        if (contact) m.senderAvatarUrl = pickAvatarUrl(contact)
      }
      if (missingOpenim.length > 0) {
        console.warn(
          '[wx] openim senders without any name',
          JSON.stringify(missingOpenim),
          'contact rows:',
          contactMap.size,
          'group nicknames:',
          groupNick?.size ?? 0
        )
      }

      // 转账参与方显示名（群昵称/备注/昵称；己方为"我"）
      for (const m of messages) {
        if (!m.transferPayerUsername && !m.transferReceiverUsername) continue
        const gmap = groupNick ?? new Map<string, string>()
        m.transferPayerName = resolvePartyName(
          m.transferPayerUsername,
          gmap,
          contactMap,
          myVariants
        )
        m.transferReceiverName = resolvePartyName(
          m.transferReceiverUsername,
          gmap,
          contactMap,
          myVariants
        )
      }
      return messages
    } finally {
      db.close()
    }
  } catch {
    return messages
  }
}

// ── 头像解析（contact URL 优先，head_image.db image_buffer 兜底）──

/** 从 head_image.db 取本地头像 BLOB → data:image base64（明文 JPEG/PNG）。usernames 为候选（原始+清洗） */
function getHeadImageAvatar(ctx: WxReaderContext, usernames: string[]): string | null {
  try {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    if (!paths.dbStoragePath) return null
    const headFile = findDbFileByName(paths.dbStoragePath, 'head_image.db')
    if (!headFile) return null
    const opened = openWxDbFile(headFile, ctx.hexKey)
    if (!opened.db) return null
    const db = opened.db
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='head_image'")
        .all()
      if (tables.length === 0) return null
      for (const u of usernames) {
        const row = db
          .prepare(
            'SELECT image_buffer FROM head_image WHERE username = ? ORDER BY update_time DESC LIMIT 1'
          )
          .get(u) as { image_buffer?: Buffer } | undefined
        const buf = row?.image_buffer
        if (!buf || !Buffer.isBuffer(buf) || buf.length < 4) continue
        const mime =
          buf[0] === 0xff && buf[1] === 0xd8
            ? 'image/jpeg'
            : buf[0] === 0x89 && buf[1] === 0x50
              ? 'image/png'
              : 'image/jpeg'
        return `data:${mime};base64,${buf.toString('base64')}`
      }
      return null
    } finally {
      db.close()
    }
  } catch {
    return null
  }
}

/**
 * 解析某 username 的头像：contact 表 URL（big/small）优先，head_image.db 本地 BLOB 兜底。
 * localOnly=true 时跳过 contact URL（用于渲染端远程 URL 加载失败后的重试，避免返回同一个坏链接）。
 * 返回 http(s) URL 或 data:image base64；都没有返回 null（渲染端用首字占位）。
 */
export function getAvatar(
  ctx: WxReaderContext,
  username: string,
  opts?: { localOnly?: boolean }
): string | null {
  if (!username) return null
  // 候选 username：原始 + 联系人级清洗（wxid 实例后缀）；若查的就是当前账号自己，
  // 再补账号目录级清洗（自定义微信号 `xxx_yyyy` 也适用）
  const candidates: string[] = [username, cleanWxid(username)]
  const acctClean = cleanAccountDirWxid(ctx.wxid)
  if (acctClean !== ctx.wxid && acctClean !== username && !candidates.includes(acctClean)) {
    candidates.push(acctClean)
  }
  // 1) contact URL（远程失败重试时跳过）
  if (!opts?.localOnly) {
    try {
      const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
      if (paths.dbStoragePath) {
        const contactFile = findContactDb(paths.dbStoragePath)
        if (contactFile) {
          const opened = openWxDbFile(contactFile, ctx.hexKey)
          if (opened.db) {
            const db = opened.db
            try {
              let contactTable: string | null = null
              const tables = db
                .prepare("SELECT name FROM sqlite_master WHERE type='table'")
                .all() as { name: string }[]
              const names = new Set(tables.map((t) => t.name))
              for (const cand of CONTACT_TABLE_CANDIDATES) {
                if (names.has(cand)) {
                  contactTable = cand
                  break
                }
              }
              if (contactTable) {
                for (const u of candidates) {
                  const row = db
                    .prepare(`SELECT * FROM ${contactTable} WHERE username = ? LIMIT 1`)
                    .get(u) as Record<string, any> | undefined
                  const url = row ? pickAvatarUrl(row) : undefined
                  if (url) return url
                }
              }
            } finally {
              db.close()
            }
          }
        }
      }
    } catch {
      /* 走 head_image 兜底 */
    }
  }
  // 2) head_image 本地头像
  return getHeadImageAvatar(ctx, candidates)
}
