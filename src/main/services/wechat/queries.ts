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
  parseRedEnvelopeSendId
} from './content'
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

function rowToMessage(
  row: Record<string, any>,
  cols: MessageTableColumns,
  nameId: NameIdMap,
  isGroup: boolean,
  myWxid: string
): ChatMessage {
  const content = decodeMessageContent(getRowField(row, [cols.contentColumn || 'message_content']))
  const localType = toNumber(getRowField(row, ['local_type', 'localType', 'type']), 1)

  // 发送人：real_sender_id -> Name2Id.user_name（真实 wxid）
  const realSenderId = toNumber(getRowField(row, ['real_sender_id', 'realSenderId']), -1)
  let senderUsername: string | null =
    realSenderId >= 0 ? nameId.idToName.get(realSenderId) || null : null
  if (!senderUsername) {
    senderUsername = toString(getRowField(row, [cols.senderColumn || 'sender'])) || null
  }

  // 是否我发的（对齐 CipherTalk 三重判定）：
  // 1) Name2Id 命中：real_sender_id == 我的 rowid（权威）
  // 2) 无 Name2Id：发送人 wxid 与 myWxid 归一化匹配
  // 3) 兜底：is_send 列（旧版兼容）
  let isSend = false
  if (nameId.myRowId !== null && realSenderId >= 0) {
    isSend = realSenderId === nameId.myRowId
  } else if (isOwnSender(senderUsername, myWxid)) {
    isSend = true
  } else {
    isSend = toNumber(getRowField(row, ['is_send', 'isSend', 'is_sender']), 0) === 1
  }

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
    // enrich 发送人昵称/头像（群消息关键）
    enrichMessagesWithSenders(page, ctx)
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

/**
 * 用 contact 库 enrich 消息发送人（昵称 + 头像）。
 * 群消息：按发送人 wxid 逐个查；私聊：对方消息用会话头像即可（渲染端处理），这里仅补昵称。
 * 自己发的消息不 enrich（渲染端用"我"的占位）。
 */
export function enrichMessagesWithSenders(
  messages: ChatMessage[],
  ctx: WxReaderContext
): ChatMessage[] {
  if (messages.length === 0) return messages
  // 只处理有真实发送人 wxid 的接收消息
  const senderIds = Array.from(
    new Set(
      messages.filter((m) => !m.isSend && m.senderUsername).map((m) => m.senderUsername as string)
    )
  )
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
      for (const m of messages) {
        if (m.isSend || !m.senderUsername) continue
        const contact = contactMap.get(m.senderUsername)
        if (!contact) continue
        m.senderNickname = pickDisplayName(contact) || m.senderUsername
        m.senderAvatarUrl = pickAvatarUrl(contact)
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
