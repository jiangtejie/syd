import { openWxDbFile } from './wxDb'
import { locateWeChatDbs } from './dbLocator'
import { getMessageTableColumns, getRowField, toNumber, toString } from './schema'
import { decodeMessageContent, parseMessageContent } from './content'
import { listSessions, messageTableHash, loadNameIdMap, toMs, isOwnSender } from './queries'
import type { WxReaderContext } from './queries'
import type { MessageTableColumns } from './schema'
import type { OpsDayPoint, OpsHourPoint, OpsStats, OpsTypeCount } from '../../../shared/types'

/**
 * 消息级运营统计（L2/L3）。
 * - 只扫描「窗口内活跃会话」（session.lastTimestamp >= 窗口起点）对应的 msg 表，避免扫全库历史分片；
 * - 方向判定与读取层一致（Name2Id + is_send 归一化）；
 * - 49 型（appmsg）与系统消息需解码正文，用于细分 红包/转账/文件/小程序 与领取回执；
 * - 结果缓存于内存，watchService 广播 dbChanged 时调用 invalidateOpsCache(wxid) 失效。
 */

const DAY_MS = 24 * 3600_000
const HOUR_MS = 3600_000
const CACHE_TTL = 60_000
const RESP_CAP_MS = 48 * DAY_MS

const BASE_TYPE_LABELS: Record<number, string> = {
  1: '文本',
  3: '图片',
  34: '语音',
  42: '名片',
  43: '视频',
  47: '表情',
  48: '位置',
  50: '通话',
  244813135921: '引用',
  10000: '系统消息'
}

/** 49 型（appmsg）解析后的前缀 -> 统一分类（parseMessageContent 返回 [xxx] 前缀文案） */
const SUBTYPE_LABELS: Record<string, string> = {
  红包: '红包',
  转账: '转账',
  文件: '文件',
  小程序: '小程序',
  链接: '链接',
  音乐: '音乐',
  聊天记录: '聊天记录',
  群公告: '群公告',
  微信礼物: '礼物'
}

/** 运行期内存缓存：`wxid:range` -> 结果 */
const cache = new Map<string, { computedAt: number; stats: OpsStats }>()
const lastInvalidate = new Map<string, number>()

/** 使某账号（或全部）的统计缓存失效（dbChanged 广播时调用，已做节流） */
export function invalidateOpsCache(wxid?: string): void {
  const now = Date.now()
  if (wxid) {
    if ((lastInvalidate.get(wxid) ?? 0) > now - 1500) return
    lastInvalidate.set(wxid, now)
    for (const key of [...cache.keys()]) {
      if (key.startsWith(`${wxid}:`)) cache.delete(key)
    }
  } else {
    cache.clear()
  }
}

/** 从表列探测中取存在的真实列名 */
function pickColumn(cols: MessageTableColumns, candidates: string[]): string | null {
  for (const c of candidates) {
    const actual = cols.lower.get(c.toLowerCase())
    if (actual) return actual
  }
  return null
}

function localDayParts(ms: number): { year: number; month: number; day: number } {
  const d = new Date(ms)
  return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() }
}

function dayBucketKey(ms: number): string {
  const { year, month, day } = localDayParts(ms)
  return `${year}-${month}-${day}`
}

/** 49 / 系统消息正文解码后归类 */
function categorizeContent(decoded: string | null, localType: number): string {
  if (localType === 49 && decoded) {
    const label = parseMessageContent(decoded, 49)
    const m = /^\[([^\]]+)\]/.exec(label)
    if (m?.[1]) {
      const mapped = SUBTYPE_LABELS[m[1]]
      if (mapped) return mapped
    }
    // 49 型未细分（引用/未知子类型）一律归为"应用/链接"
    return '应用/链接'
  }
  return '其他'
}

/** 是否存在"红包已被领取"回执（对齐系统消息常见文案） */
function isClaimReceipt(decoded: string | null): boolean {
  if (!decoded) return false
  const text = parseMessageContent(decoded, 10000)
  if (!/红包/.test(text)) return false
  return /(已领取|被领取|已领取了|领取了)/.test(text)
}

interface AggResult {
  buckets: Map<string, { in: number; out: number }>
  days: Array<{ key: string; label: string }>
  hours: OpsHourPoint[]
  totals: { total: number; inbound: number; outbound: number; group: number; privateChat: number }
  types: Map<string, number>
  redPackets: { sent: number; received: number; claimReceipts: number }
  sessionEvents: Map<string, Array<{ t: number; out: boolean }>>
}

function buildWindow(range: number, now: number): { startMs: number; days: AggResult['days'] } {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const startMs = today.getTime() - (range - 1) * DAY_MS
  const days: AggResult['days'] = []
  for (let i = 0; i < range; i++) {
    const d = new Date(startMs + i * DAY_MS)
    days.push({ key: dayBucketKey(d.getTime()), label: `${d.getMonth() + 1}/${d.getDate()}` })
  }
  return { startMs, days }
}

export function computeOpsStats(ctx: WxReaderContext, range = 7): OpsStats {
  const now = Date.now()
  const cacheKey = `${ctx.wxid}:${range}`
  const hit = cache.get(cacheKey)
  if (hit && now - hit.computedAt < CACHE_TTL) return hit.stats

  const { startMs, days } = buildWindow(range, now)
  const agg: AggResult = {
    buckets: new Map(days.map((d) => [d.key, { in: 0, out: 0 }])),
    days,
    hours: Array.from({ length: 24 }, (_, hour) => ({ hour, inbound: 0, outbound: 0 })),
    totals: { total: 0, inbound: 0, outbound: 0, group: 0, privateChat: 0 },
    types: new Map(),
    redPackets: { sent: 0, received: 0, claimReceipts: 0 },
    sessionEvents: new Map()
  }

  const listRes = listSessions(ctx)
  if (!listRes.ok || !listRes.sessions) {
    throw new Error(listRes.error || '读取会话列表失败')
  }
  // 只统计窗口内有消息的会话，避免全库扫历史分片
  const metaByHash = new Map<string, { username: string; isGroup: boolean }>()
  for (const s of listRes.sessions) {
    if (!s.lastTimestamp || s.lastTimestamp < startMs) continue
    metaByHash.set(messageTableHash(s.username), { username: s.username, isGroup: !!s.isGroup })
  }

  if (metaByHash.size > 0) {
    const paths = locateWeChatDbs(ctx.dbPath, ctx.wxid)
    for (const file of paths.msgDbFiles || []) {
      const opened = openWxDbFile(file, ctx.hexKey)
      if (!opened.db) continue
      const db = opened.db
      try {
        const nameId = loadNameIdMap(db, ctx.wxid)
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type='table' AND lower(name) LIKE 'msg_%'")
          .all() as { name: string }[]
        for (const t of tables) {
          const hashMatch = /^msg_([0-9a-f]{32})$/.exec(t.name.toLowerCase())
          const meta = hashMatch ? metaByHash.get(hashMatch[1]) : undefined
          if (!meta) continue
          const cols = getMessageTableColumns(db, t.name)
          if (!cols.contentColumn && !cols.hasIsSend && !cols.hasLocalType) continue
          const createCol = pickColumn(cols, ['create_time', 'createTime', 'timestamp'])
          if (!createCol) continue
          const typeCol = pickColumn(cols, ['local_type', 'localType', 'type'])
          const isSendCol = pickColumn(cols, ['is_send', 'isSend', 'is_sender'])

          // 探测时间戳单位（秒级 ×1000 / 毫秒级）后按列过滤窗口
          const probe = db
            .prepare(
              `SELECT "${createCol}" AS c FROM "${t.name}" WHERE "${createCol}" IS NOT NULL ORDER BY "${createCol}" DESC LIMIT 1`
            )
            .get() as { c?: number } | undefined
          const rawMax = probe?.c ? toNumber(probe.c) : 0
          if (!rawMax) continue
          const startRaw = rawMax > 1e12 ? startMs : Math.floor(startMs / 1000)

          const sel: string[] = [`"${createCol}"`]
          if (typeCol) sel.push(`"${typeCol}"`)
          if (cols.hasRealSenderId) sel.push('real_sender_id')
          if (isSendCol) sel.push(`"${isSendCol}"`)
          if (cols.senderColumn) sel.push(`"${cols.senderColumn}"`)
          if (cols.contentColumn) sel.push(`"${cols.contentColumn}"`)
          const rows = db
            .prepare(
              `SELECT ${sel.join(', ')} FROM "${t.name}" WHERE "${createCol}" >= ? ORDER BY "${createCol}" ASC`
            )
            .all(startRaw) as Record<string, unknown>[]

          for (const row of rows) {
            const timeMs = toMs(toNumber(getRowField(row, [createCol])))
            if (timeMs < startMs) continue

            // 方向判定（对齐 queries.rowToMessage 口径）
            const realId = cols.hasRealSenderId
              ? toNumber(getRowField(row, ['real_sender_id']), -1)
              : -1
            let senderWxid: string | null = realId >= 0 ? nameId.idToName.get(realId) || null : null
            if (!senderWxid && cols.senderColumn) {
              senderWxid = toString(getRowField(row, [cols.senderColumn])) || null
            }
            let out = false
            if (nameId.myRowId !== null && realId >= 0) {
              out = realId === nameId.myRowId
            } else if (isOwnSender(senderWxid, ctx.wxid)) {
              out = true
            } else if (isSendCol) {
              out = toNumber(getRowField(row, [isSendCol])) === 1
            }

            const key = dayBucketKey(timeMs)
            const bucket = agg.buckets.get(key)
            if (bucket) {
              if (out) bucket.out++
              else bucket.in++
            }
            const hour = new Date(timeMs).getHours()
            if (out) agg.hours[hour].outbound++
            else agg.hours[hour].inbound++
            if (meta.isGroup) agg.totals.group++
            else agg.totals.privateChat++
            if (out) agg.totals.outbound++
            else agg.totals.inbound++
            agg.totals.total++

            // 类型归类：仅 49/系统消息 需要解码正文细分
            const localType = typeCol ? toNumber(getRowField(row, [typeCol]), 1) : 1
            let category: string
            if (localType === 49 || localType === 10000) {
              const contentCol = cols.contentColumn
              const raw = contentCol ? getRowField(row, [contentCol]) : undefined
              const decoded = raw === undefined || raw === null ? null : decodeMessageContent(raw)
              category =
                localType === 49
                  ? categorizeContent(decoded, 49)
                  : BASE_TYPE_LABELS[10000] || '系统消息'
              if (localType === 10000 && isClaimReceipt(decoded)) agg.redPackets.claimReceipts++
            } else {
              category = BASE_TYPE_LABELS[localType] || '其他'
            }
            if (category === '红包') {
              if (out) agg.redPackets.sent++
              else agg.redPackets.received++
            }
            agg.types.set(category, (agg.types.get(category) ?? 0) + 1)

            const events = agg.sessionEvents.get(meta.username)
            if (events) events.push({ t: timeMs, out })
            else agg.sessionEvents.set(meta.username, [{ t: timeMs, out }])
          }
        }
      } finally {
        db.close()
      }
    }
  }

  // ── 响应时效：每个会话按时间排序，一次回复结算其最近一条未回客户消息 ──
  const gapSamples: number[] = []
  let within30Min = 0
  let within2h = 0
  let noResponse = 0
  for (const evs of agg.sessionEvents.values()) {
    if (evs.length < 2) continue
    evs.sort((a, b) => a.t - b.t)
    const pending: number[] = []
    for (const ev of evs) {
      if (ev.out) {
        if (pending.length > 0) {
          const gap = ev.t - pending[pending.length - 1]
          pending.length = 0
          if (gap >= 0 && gap <= RESP_CAP_MS) {
            gapSamples.push(gap)
            if (gap <= 30 * 60_000) within30Min++
            if (gap <= 2 * HOUR_MS) within2h++
          }
        }
      } else {
        pending.push(ev.t)
      }
    }
    for (const t of pending) {
      if (now - t > 2 * HOUR_MS) noResponse++
    }
  }
  gapSamples.sort((a, b) => a - b)
  const medianMinutes =
    gapSamples.length > 0
      ? Math.round(gapSamples[Math.floor(gapSamples.length / 2)] / 60_000)
      : null

  // ── 组装输出 ──
  const trend: OpsDayPoint[] = agg.days.map((d) => {
    const b = agg.buckets.get(d.key)!
    return { day: d.label, inbound: b.in, outbound: b.out }
  })
  const typeDist: OpsTypeCount[] = [...agg.types.entries()]
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count)

  const stats: OpsStats = {
    range,
    computedAt: now,
    totals: { ...agg.totals },
    trend,
    hours: agg.hours,
    typeDist,
    redPackets: { ...agg.redPackets },
    response: { samples: gapSamples.length, within30Min, within2h, noResponse, medianMinutes }
  }
  cache.set(cacheKey, { computedAt: now, stats })
  return stats
}
