import { buildWxSession } from '../wechat/wxService'
import {
  listMessages,
  listSessions,
  enrichSessionsWithContacts,
  enrichMessagesWithSenders,
  toMs
} from '../wechat/queries'
import type { ChatMessage, SessionSummary } from '../../../shared/types'
import { createLogger } from '../logging'
import { Client } from 'pg'
import { listJobCursors, saveJobCursors } from '../../db/repos/reportRepo'
import { toPgRow } from './messageRow'
import { asrTencentStatus, hasVoiceTranscript, transcribeVoice } from '../media/asrTencent'
import { decorateVoiceTranscripts } from '../media/voiceTranscript'
import {
  composeVoiceContent,
  DEFAULT_ASR_PER_RUN,
  pickVoiceAsrTasks,
  voiceCacheName,
  voiceRowOf,
  type VoicePlanRow
} from '../media/voiceText'
import {
  ensurePgSchema,
  updatePgVoice,
  upsertPgMessages,
  upsertPgSessions,
  refreshPgSessionStats,
  closePg,
  type PgMessageRow,
  type VoicePgUpdate,
  type PgSessionRow
} from './pgWriter'
import {
  archiveMediaJobs,
  archiveVoiceMedia,
  backfillMissingMedia,
  mediaJobOf,
  repairMediaPaths,
  type MediaJob
} from './mediaArchive'

/** 媒体归档/补全单轮预算(防首轮海量解密拖长单轮) */
const MEDIA_BUDGET = 200

/**
 * chat_sync 任务:把本地微信账号的聊天记录增量上报到 PostgreSQL
 * (chat.sessions / chat.messages,与 chat-sync 完全同构)。
 *
 * 吸取自 chat-sync 的健壮性协议:
 * - 会话预筛:lastTimestamp ≤ 游标且 5 分钟内实拉过 → 跳过(无新消息);
 * - 无消息会话 30 分钟短期记忆(no_msg_at),防每轮重复全量;
 * - 5 分钟兜底重拉:last_fetch_at 陈旧强制重拉(防游标/陈旧时间戳误跳过);
 * - 单会话 90s 超时保护:已拉数据照常入库,但游标不推进(下轮续传);
 * - 游标推进防污染:以 sortSeq 为准(库内单调),时间戳仅记录;超时/失败不写游标;
 * - 幂等 upsert + 批量 500/批 + 每轮独立 PG 连接,结束必释放;
 * - 失败降噪:明细只在第 1/10/20… 轮输出,恢复时提示一次(由 scheduler 维护);
 * - 性能:页扫阶段 skipEnrich(免每库名称表/每页联系人 enrich),收齐后按会话一次性
 *   enrich + 批量写;页/会话/批间隙 setImmediate 让出主进程事件循环,UI 不卡死;
 * - 媒体归档到缓存目录 <cache>/media/<账号>(media_path 相对缓存根),单轮限量。
 */

const clawLog = createLogger('report')
const PAGE = 500
const BATCH = 1000
const SESSION_TIMEOUT_MS = 90_000
const NO_MSG_MEMORY_MS = 30 * 60_000
const RECHECK_INTERVAL_MS = 5 * 60_000

/** 语音转写失败记忆(进程内):同一段语音连续失败 3 次就不再尝试,免得每轮白烧预算;重启复位 */
const asrFails = new Map<string, number>()
/** 「ASR 未配置」提示只打一次(任务每 2 分钟一轮,别把日志刷满) */
let asrWarned = false

/** 让出事件循环(同步读库/解密之间存在大量同步热点,保证主进程 UI 不被饿死) */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r))

/** 运行进度(节流由调用方做) */
export interface ChatSyncProgress {
  phase: 'sessions' | 'media' | 'done'
  /** 本轮计划处理会话数 */
  total: number
  /** 已处理会话数(含跳过/失败) */
  done: number
  added: number
  elapsedMs: number
}

export interface ChatSyncRunResult {
  ok: boolean
  error?: string
  added: number
  sessionsOk: number
  sessionsSkip: number
  errors: string[]
  interrupted: boolean
  summary: string
}

/** 同一段语音连续失败几次后不再尝试（进程内记忆；重启复位） */
const ASR_MAX_FAILS = 3

/** PG 标识符 quoting（语音补写要自己拼一条 SELECT，schema 名来自配置） */
function quoteSchema(schema: string): string {
  return `"${(schema || 'chat').replace(/"/g, '""')}"`
}

/** 库里仍是占位、且没有转写文本的语音行（历史补写用；新→旧） */
async function selectVoiceRowsMissingText(
  client: Client,
  schema: string,
  limit: number
): Promise<{ sessionWxid: string; localId: number; createTime: number }[]> {
  if (limit <= 0) return []
  const rows = (
    await client.query(
      `SELECT session_wxid, local_id, create_time FROM ${quoteSchema(schema)}.messages
       WHERE msg_type = '语音消息' AND (voice_text IS NULL OR voice_text = '')
       ORDER BY create_time DESC LIMIT $1`,
      [limit]
    )
  ).rows as { session_wxid: string; local_id: number; create_time: number }[]
  return rows.map((r) => ({
    sessionWxid: String(r.session_wxid ?? ''),
    localId: Number(r.local_id) || 0,
    // 原样传库里的秒：VoiceInfo.create_time 就是秒（实测 4.x media_*.db，与消息表同一口径）。
    // 传毫秒也能被 findVoiceSilk 的换算兜底，但没必要多绕一次查询
    createTime: Number(r.create_time) || 0
  }))
}

/**
 * 语音转写一批：**本轮新入库的**优先，剩余预算给**历史仍是 `[语音]`**的行补文本。
 *
 * 为什么要主动转：批量上报走 skipEnrich，读取层那次「已有转写合流」不会发生 ——
 * 不主动转，PG 里的语音永远只有 `[语音]` 占位，下游（AI / 报表 / RAG）等于看不到这条语音说了什么。
 *
 * 预算 = **尝试次数**（含失败），每轮封顶：一条坏语音不会把名额一直吃掉
 * —— 同一段连续失败 ${ASR_MAX_FAILS} 次后不再尝试（进程内记忆；重启复位）。
 */
async function transcribeVoiceBatch(opts: {
  client: Client
  schema: string
  accountWxid: string
  budget: number
  jobId: number
  /** 本轮新入库的语音 */
  fresh: VoicePlanRow[]
  signal?: AbortSignal
}): Promise<{ note: string }> {
  if (opts.budget <= 0) return { note: '' }
  const status = asrTencentStatus()
  if (!status.available) {
    if (opts.fresh.length > 0 && !asrWarned) {
      asrWarned = true
      clawLog.info(
        `job=${opts.jobId} 有 ${opts.fresh.length} 条语音待转写，但腾讯云 ASR 未就绪：${status.reason ?? '未配置'}`
      )
    }
    return { note: '' }
  }

  let budgetLeft = opts.budget
  let ok = 0
  let failed = 0
  // 失败原因汇总：只记第一条会让人以为"都一个原因"，这里按原因分桶，日志末尾一次说清
  const failReasons = new Map<string, number>()
  const noteFail = (reason: string): void => {
    const key = (reason || '未知原因').replace(/\s+/g, ' ').slice(0, 40)
    failReasons.set(key, (failReasons.get(key) ?? 0) + 1)
  }
  const updates: VoicePgUpdate[] = []

  const attempt = async (
    row: {
      sessionWxid: string
      localId: number
      serverId?: string
      createTime: number
      durationMs: number | null
    },
    cacheName: string,
    secondsFallback: number | null
  ): Promise<boolean> => {
    const res = await transcribeVoice({
      wxid: opts.accountWxid,
      serverId: row.serverId || undefined,
      localId: row.localId || undefined,
      createTime: row.createTime || undefined
    })
    budgetLeft--
    if (res.ok && res.text) {
      ok++
      asrFails.delete(cacheName)
      const byAsr =
        typeof res.audioDurationMs === 'number' && res.audioDurationMs > 0
          ? Math.max(1, Math.round(res.audioDurationMs / 1000))
          : null
      updates.push({
        sessionWxid: row.sessionWxid,
        localId: row.localId,
        content: composeVoiceContent(byAsr ?? secondsFallback, res.text),
        voiceText: res.text,
        voiceDurationMs: row.durationMs ?? res.audioDurationMs ?? null
      })
      return true
    }
    failed++
    asrFails.set(cacheName, (asrFails.get(cacheName) ?? 0) + 1)
    noteFail(res.error ?? '未知原因')
    if (failed === 1) {
      clawLog.warn(`job=${opts.jobId} 语音转写失败 ${cacheName}: ${res.error ?? '未知原因'}`)
    }
    return false
  }

  // ① 本轮新入库的语音（新→旧，跳过已转写 / 超长 / 连续失败的）
  const tasks = pickVoiceAsrTasks(opts.fresh, {
    hasTranscript: (name) => hasVoiceTranscript(opts.accountWxid, name),
    budget: budgetLeft,
    skip: (name) => (asrFails.get(name) ?? 0) >= ASR_MAX_FAILS
  })
  for (const t of tasks) {
    if (opts.signal?.aborted || budgetLeft <= 0) break
    await tick()
    await attempt(t, t.cacheName, t.seconds)
  }

  // ② 历史补写：库里仍是 [语音] 的行（本轮剩余预算）；只按 localId + create_time 定位 SILK
  if (!opts.signal?.aborted && budgetLeft > 0) {
    let history: { sessionWxid: string; localId: number; createTime: number }[] = []
    try {
      history = await selectVoiceRowsMissingText(opts.client, opts.schema, budgetLeft)
    } catch (e) {
      clawLog.warn(
        `job=${opts.jobId} 查询待补语音失败: ${e instanceof Error ? e.message : String(e)}`
      )
    }
    for (const r of history) {
      if (opts.signal?.aborted || budgetLeft <= 0) break
      const cacheName = voiceCacheName(undefined, r.localId)
      if (!cacheName) continue
      if ((asrFails.get(cacheName) ?? 0) >= ASR_MAX_FAILS) continue
      await tick()
      const okRow = await attempt({ ...r, serverId: undefined, durationMs: null }, cacheName, null)
      if (okRow) {
        // 历史行早就过了游标，不会再出现在 mediaJobs 里：转写成功时顺手把音频也归档掉
        try {
          await archiveVoiceMedia(
            opts.client,
            { schema: opts.schema, accountWxid: opts.accountWxid },
            r
          )
        } catch (e) {
          clawLog.warn(
            `job=${opts.jobId} 语音归档失败 ${cacheName}: ${e instanceof Error ? e.message : String(e)}`
          )
        }
      }
    }
  }

  if (updates.length > 0) {
    try {
      await updatePgVoice(opts.client, opts.schema, updates)
    } catch (e) {
      clawLog.warn(
        `job=${opts.jobId} 语音转写回写失败: ${e instanceof Error ? e.message : String(e)}`
      )
    }
  }
  if (ok > 0 || failed > 0) {
    const reasons = [...failReasons.entries()]
      .map(([reason, n]) => (n > 1 ? `${reason}×${n}` : reason))
      .join('、')
    clawLog.info(
      `job=${opts.jobId} 语音转写：成功 ${ok} 条，失败 ${failed} 条${reasons ? `（${reasons}）` : ''}`
    )
  }
  if (ok === 0 && failed === 0) return { note: '' }
  return { note: ` · 语音转写 ${ok} 条${failed > 0 ? `(失败 ${failed})` : ''}` }
}

export async function runChatSyncJob(
  jobId: number,
  cfg: {
    accountWxid: string
    scope: {
      sessionMode: string
      sessionList?: string
      daysBack: number
      maxPerRun: number
      sessionsPerRun?: number
      mediaDir?: string
      /** 每轮最多转写几条语音（0=关闭）；缺省走 DEFAULT_ASR_PER_RUN */
      asrPerRun?: number
    }
    target: {
      host: string
      port: number
      database: string
      user: string
      schema: string
      password?: string
    }
  },
  signal?: AbortSignal,
  onProgress?: (p: ChatSyncProgress) => void
): Promise<ChatSyncRunResult> {
  const t0 = Date.now()
  const errors: string[] = []
  const report = (
    phase: ChatSyncProgress['phase'],
    total: number,
    done: number,
    cur: number
  ): void => {
    onProgress?.({ phase, total, done, added: cur, elapsedMs: Date.now() - t0 })
  }
  const base = buildWxSession(cfg.accountWxid)
  if (!base)
    return {
      ok: false,
      error: '账号未导入密钥,请先在 微信数据 页导入',
      added: 0,
      sessionsOk: 0,
      sessionsSkip: 0,
      errors: [],
      interrupted: false,
      summary: '来源账号不可用'
    }
  if (!base.dbPath)
    return {
      ok: false,
      error: '账号缺少微信数据根路径',
      added: 0,
      sessionsOk: 0,
      sessionsSkip: 0,
      errors: [],
      interrupted: false,
      summary: '来源账号不可用'
    }

  // 目标连接(PG)
  const client: Client = new Client({
    host: cfg.target.host,
    port: cfg.target.port || 5432,
    database: cfg.target.database,
    user: cfg.target.user,
    password: cfg.target.password ?? '',
    connectionTimeoutMillis: 10_000,
    options: '-c statement_timeout=60000'
  })
  try {
    await client.connect()
    await ensurePgSchema(client, cfg.target.schema || 'chat')
  } catch (e) {
    return {
      ok: false,
      error: `连接目标库失败: ${e instanceof Error ? e.message : e}`,
      added: 0,
      sessionsOk: 0,
      sessionsSkip: 0,
      errors: [],
      interrupted: false,
      summary: '目标库不可达'
    }
  }

  try {
    // 1. 会话列表(enrich 展示名,失败降级用原始名)
    const listRes = listSessions(base)
    if (!listRes.ok || !listRes.sessions) {
      return {
        ok: false,
        error: listRes.error ?? '读取会话失败',
        added: 0,
        sessionsOk: 0,
        sessionsSkip: 0,
        errors: [],
        interrupted: false,
        summary: '来源会话库不可读'
      }
    }
    let sessions = listRes.sessions
    try {
      enrichSessionsWithContacts(sessions, base)
    } catch {
      /* 联系人库不可读:降级使用会话原始名 */
    }
    const scope = cfg.scope
    const listWhitelist = new Set(
      (scope.sessionList ?? '')
        .split(/[\s,，]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    )
    if (scope.sessionMode === 'groups') sessions = sessions.filter((s) => s.isGroup)
    else if (scope.sessionMode === 'single') sessions = sessions.filter((s) => !s.isGroup)
    else if (scope.sessionMode === 'list')
      sessions = sessions.filter((s) => listWhitelist.has(s.username))

    // 2. 预筛 + 首次会话行写入
    const cursors = listJobCursors(jobId)
    const now = Date.now()
    const noMsg = new Map<string, number>()
    for (const [sid, r] of cursors)
      if (r.no_msg_at && now - r.no_msg_at < NO_MSG_MEMORY_MS) noMsg.set(sid, r.no_msg_at)
    const lastFetch = new Map<string, number>()
    for (const [sid, r] of cursors) if (r.last_fetch_at) lastFetch.set(sid, r.last_fetch_at)

    const toFetch: SessionSummary[] = []
    const sessionRows: PgSessionRow[] = []
    let noChange = 0
    for (const s of sessions) {
      const c = cursors.get(s.username)
      const cursorSeq = c?.cursor_seq ?? 0
      const cursorMs = c?.cursor_ms ?? 0
      const lastTs = s.lastTimestamp ?? 0
      const fetchedAt = lastFetch.get(s.username) ?? 0
      if (
        cursorSeq > 0 &&
        lastTs > 0 &&
        cursorMs >= lastTs &&
        now - fetchedAt < RECHECK_INTERVAL_MS
      ) {
        noChange++
        continue
      }
      if (noMsg.has(s.username)) {
        noChange++
        continue
      }
      toFetch.push(s)
      sessionRows.push({
        sessionId: s.username,
        displayName: (s.displayName || s.username).slice(0, 200),
        sessionType: s.isGroup ? 'group' : 'single',
        ownerId: cfg.accountWxid,
        messageCount: null,
        firstMessageTime: null,
        lastMessageTime: lastTs > 0 ? Math.floor(lastTs / 1000) : null,
        exportedAt: Math.floor(now / 1000)
      })
    }
    await upsertPgSessions(client, cfg.target.schema || 'chat', sessionRows)

    // 3. 逐会话增量拉取(倒序 keyset 分页 → 只取游标之后;单会话超时保护)
    //    会话预算:首轮全量可分多轮切(未处理会话游标不动,下轮自动续)
    const earliestMs = scope.daysBack > 0 ? now - scope.daysBack * 24 * 3600 * 1000 : 0
    const spr = Math.max(0, Math.floor(scope.sessionsPerRun ?? 0))
    const sessionBudget = spr > 0 ? Math.min(toFetch.length, spr) : toFetch.length
    const work = toFetch.slice(0, sessionBudget)
    let sessionOk = 0
    let sessionSkip = 0
    let added = 0
    const newCursors = new Map<string, { seq: number; ms: number; lastFetch: number }>()
    const touched: string[] = []
    const mediaJobs: MediaJob[] = []
    /** 本轮新入库的语音(localType 34):媒体阶段按预算转写 */
    const voiceJobs: VoicePlanRow[] = []
    const maxPerRun = scope.maxPerRun || 0

    clawLog.info(
      `job=${jobId} 需拉取会话 ${work.length}/${toFetch.length}(预筛跳过 ${noChange}${
        sessionBudget < toFetch.length ? `,会话预算 ${sessionBudget},剩余下轮续` : ''
      })`
    )

    let doneCount = 0
    for (const s of work) {
      if (signal?.aborted) break
      report('sessions', work.length, doneCount, added)
      doneCount++
      const prevC = cursors.get(s.username)
      const cursorSeq = prevC?.cursor_seq ?? 0
      const sessionStart = Date.now()
      // 会话内收集原始消息:页扫阶段跳过每库名称表/每页 enrich(同步热点),
      // 收齐后一次性 enrich + 批量 upsert,主进程事件循环只在页/会话间隙被让出
      const raw: ChatMessage[] = []
      let newCount = 0
      let maxSeq = cursorSeq
      let maxMs = prevC?.cursor_ms ?? 0
      let anySeen = false
      let timedOut = false
      let fatal: string | null = null
      let persistErr: string | null = null
      let before: { sortSeq: number; createTime: number; localId: number } | undefined
      try {
        for (;;) {
          if (Date.now() - sessionStart > SESSION_TIMEOUT_MS) {
            timedOut = true
            break
          }
          const page = listMessages(base, s.username, PAGE, before, true /* skipEnrich */)
          if (!page.ok) {
            fatal = page.error ?? '读取消息失败'
            break
          }
          const msgs = page.messages ?? []
          if (msgs.length === 0) break
          let stopReason: 'old' | 'cut' | 'limit' | null = null
          // listMessages 每页升序(旧→新):从页尾(最新)倒序扫描,
          // 遇到 ≤ 游标的行即说明其后(更旧)全为旧消息 → 停止
          for (let k = msgs.length - 1; k >= 0; k--) {
            const m = msgs[k]
            anySeen = true
            const seq = Number(m.sortSeq)
            if (!(Number.isInteger(seq) && seq > cursorSeq)) {
              stopReason = 'old'
              break
            }
            const createMs = toMs(m.createTime)
            // 首轮时间窗之外的更早消息:不取(其 seq 必小于已处理的新行,停在此处不推进)
            if (earliestMs > 0 && createMs < earliestMs) {
              stopReason = 'cut'
              break
            }
            raw.push(m)
            newCount++
            if (seq > maxSeq) maxSeq = seq
            if (createMs > maxMs) maxMs = createMs
            if (maxPerRun > 0 && added + newCount >= maxPerRun) {
              stopReason = 'limit'
              break
            }
          }
          if (fatal || stopReason !== null) break
          if (!page.hasMore || !page.nextCursor) break
          before = page.nextCursor
          await tick() // 页间隙让出事件循环(同步读库后 UI 呼吸)
        }
        // 会话收尾:一次性 enrich + 批量写(超时/失败也把已取部分入库,游标不动)
        if (raw.length > 0) {
          // enrich 仅用于展示名:失败降级不影响上报
          try {
            enrichMessagesWithSenders(raw, base, s.username)
          } catch {
            /* 联系人/群昵称库不可读:展示名留空 */
          }
          // 已转写过的语音:把文本并进 parsedContent,落库时 content 就是「[语音] N″ 文本」
          // (读取层的合流只在 skipEnrich=false 时发生,批量同步必须自己补这一步)
          try {
            decorateVoiceTranscripts(raw, cfg.accountWxid)
          } catch {
            /* 缓存目录不可读:按未转写处理 */
          }
          try {
            const rows: PgMessageRow[] = []
            for (const m of raw) {
              const r = toPgRow(s.username, m)
              if (r) rows.push(r)
              const mj = mediaJobOf(s.username, m)
              if (mj) mediaJobs.push(mj)
              const vj = voiceRowOf(s.username, m)
              if (vj) voiceJobs.push(vj)
            }
            for (let i = 0; i < rows.length; i += BATCH) {
              await upsertPgMessages(client, cfg.target.schema || 'chat', rows.slice(i, i + BATCH))
              await tick()
            }
          } catch (e) {
            persistErr = e instanceof Error ? e.message : String(e)
          }
        }
        if (signal?.aborted) break // 外层会话循环一并退出
        if (persistErr !== null) {
          errors.push(`${s.username}: 入库失败:${persistErr}`)
          sessionSkip++
        } else if (anySeen) {
          if (timedOut) {
            // 超时:不推进游标(下轮续传);已入库数据幂等无副作用
            errors.push(`${s.username}: 会话同步超时,已跳过(已拉取部分已入库,下次续传)`)
          } else if (fatal) {
            errors.push(`${s.username}: ${fatal}`)
          } else {
            newCursors.set(s.username, { seq: maxSeq, ms: maxMs, lastFetch: Date.now() })
            if (maxSeq > cursorSeq) touched.push(s.username)
          }
        }
        if (persistErr === null && !timedOut && !fatal) sessionOk++
        else if (persistErr === null) sessionSkip++
        added += newCount
        if (newCount > 0) {
          clawLog.info(`job=${jobId} ${s.username} ${s.displayName || ''} +${newCount} 条`)
        }
        if (
          fatal === null &&
          !timedOut &&
          persistErr === null &&
          newCount === 0 &&
          !cursors.has(s.username)
        ) {
          // 该会话确实还没有消息表/消息:进 30 分钟短期记忆(防每轮重复空扫)
          noMsg.set(s.username, Date.now())
        }
      } catch (e) {
        errors.push(`${s.username}: ${e instanceof Error ? e.message : String(e)}`)
        sessionSkip++
      }
      if (maxPerRun > 0 && added >= maxPerRun) break
      await tick()
    }

    // 4. 游标落库(仅成功的会话)+ 聚合回填 + 媒体归档(chat-sync 语义) + 汇总
    saveJobCursors(jobId, newCursors, noMsg)
    await refreshPgSessionStats(client, cfg.target.schema || 'chat', touched)
    let mediaNote = ''
    let voiceNote = ''
    if (!signal?.aborted) {
      report('media', work.length, doneCount, added)
      const archOpts = {
        schema: cfg.target.schema || 'chat',
        accountWxid: cfg.accountWxid,
        dbPath: base.dbPath
      }
      const mediaArch = await archiveMediaJobs(client, archOpts, mediaJobs, MEDIA_BUDGET, signal)
      const backfill = await backfillMissingMedia(
        client,
        archOpts,
        MEDIA_BUDGET,
        (sessionId, limit, before) => listMessages(base, sessionId, limit, before)
      )
      // 归档路径修复：旧的扁平归档文件被缓存策略回收后，把 media_path 改指到 archive/ 里的同名文件
      const repair = await repairMediaPaths(
        client,
        { schema: archOpts.schema, accountWxid: cfg.accountWxid },
        300
      )
      const sum = mediaArch.done + mediaArch.failed + mediaArch.skippedNoSource + backfill.done
      if (sum > 0 || repair.repaired > 0) {
        mediaNote =
          ` · 媒体归档 ${mediaArch.done + backfill.done} 份(缺源 ${mediaArch.skippedNoSource + backfill.skippedNoSource}、失败 ${mediaArch.failed + backfill.failed})` +
          (repair.repaired > 0 ? ` · 路径修复 ${repair.repaired}` : '')
      }
      // 语音：本轮新入库的 + 历史仍是 `[语音]` 的，共用一份预算补转写文本
      const asr = await transcribeVoiceBatch({
        client,
        schema: archOpts.schema,
        accountWxid: cfg.accountWxid,
        budget: Math.max(0, Math.floor(scope.asrPerRun ?? DEFAULT_ASR_PER_RUN)),
        jobId,
        fresh: voiceJobs,
        signal
      })
      voiceNote = asr.note
    }
    const interrupted = signal?.aborted === true
    const remaining =
      sessionBudget < toFetch.length ? `,剩 ${toFetch.length - sessionBudget} 会话下轮续` : ''
    const summary = `会话 ${sessionOk}/${work.length} 成功${sessionSkip ? `,跳过 ${sessionSkip}` : ''}${remaining} · 上报 ${added} 条${mediaNote}${voiceNote} · 耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
    report('done', work.length, doneCount, added)
    if (sessionSkip > 0 || errors.length > 0) clawLog.warn(`job=${jobId} ${summary}`)
    else clawLog.info(`job=${jobId} ${summary}`)
    return {
      ok: errors.length === 0 && !interrupted,
      error: interrupted
        ? '已停止'
        : errors.length > 0
          ? `${errors.length} 个会话失败,见明细`
          : undefined,
      added,
      sessionsOk: sessionOk,
      sessionsSkip: sessionSkip,
      errors,
      interrupted,
      summary
    }
  } finally {
    await closePg(client)
  }
}
