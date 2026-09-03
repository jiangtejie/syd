import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor } from '../lib/ui'
import type {
  SendOverview,
  SessionSummary,
  SendStatusInfo,
  OpsStats,
  OpsDayPoint,
  OpsHourPoint,
  OpsTypeCount
} from '../../../shared/types'
import './dashboard.css'

/**
 * 私域运营看板：顶部运营指标带 + 跟进队列（待回复/沉睡召回）+ 会话与发送审计。
 * 会话类指标来自真实微信库（sessions）；发送统计全部来自本地审计日志 send_log。
 * 不使用任何 mock / 哈希示例数据。
 */

interface DayStat {
  day: string
  sent: number
  failed: number
}

const DAY_MS = 24 * 3600_000
/** 超时未回阈值：有未读且最后消息距今超过该时长 */
const OVERDUE_MS = 2 * 3600_000
/** 沉睡召回窗口：近 7~30 天未联系的个人会话 */
const SLEEP_MIN_MS = 7 * DAY_MS
const SLEEP_MAX_MS = 30 * DAY_MS
/** 队列单列表格最大展示条数 */
const QUEUE_SHOW = 12

/** 会话构成片段（真实分类，来自 SessionSummary 的类型标记） */
interface CompSegment {
  key: string
  label: string
  color: string
  n: number
}

const RESULT_LABEL: Record<string, string> = {
  sent: '成功',
  failed: '失败',
  rejected: '被频控拦截',
  halted: '熔断拦截'
}

/** 相对时间文案（纯函数，now 由外部传入避免渲染期取时间） */
function fmtAge(now: number, ts: number): string {
  if (!now || !ts) return ''
  const diff = now - ts
  if (diff < 0) return '刚刚'
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  const days = Math.floor(hours / 24)
  if (days === 1) return '昨天'
  return `${days} 天前`
}

/** 占比（0~100 取整），total 为 0 时返回 0 */
function pct(part: number, total: number): number {
  return total > 0 ? Math.round((part / total) * 100) : 0
}

/** 每日收发堆叠柱（近 30 日时自动抽稀日期标签） */
function OpsTrend({ points }: { points: OpsDayPoint[] }): React.JSX.Element {
  const max = Math.max(...points.map((p) => p.inbound + p.outbound), 1)
  const dense = points.length > 10
  return (
    <div className="db-bars">
      {points.map((p, i) => {
        const total = p.inbound + p.outbound
        return (
          <div
            key={`${p.day}-${i}`}
            className="db-bar-col"
            title={`${p.day} · 客户发 ${p.inbound} · 我发 ${p.outbound}`}
          >
            {!dense && <div className="db-bar-val">{total > 0 ? total : ''}</div>}
            <div
              className="db-bar-stack"
              style={total > 0 ? { height: `${(total / max) * 100}%` } : undefined}
            >
              <div className="db-bar in" style={{ height: `${pct(p.inbound, total)}%` }} />
              <div className="db-bar out" style={{ height: `${pct(p.outbound, total)}%` }} />
            </div>
            <div className="db-bar-day">{dense && i % 5 !== 0 ? '' : p.day}</div>
          </div>
        )
      })}
    </div>
  )
}

/** 24 小时时段分布（每列堆叠客户发/我发，4 小时一个刻度） */
function OpsHours({ hours }: { hours: OpsHourPoint[] }): React.JSX.Element {
  const sums = hours.map((h) => h.inbound + h.outbound)
  const maxSum = Math.max(...sums, 1)
  let peakIdx = 0
  for (let i = 1; i < sums.length; i++) {
    if (sums[i] > sums[peakIdx]) peakIdx = i
  }
  const hasData = sums[peakIdx] > 0
  const peak = hours[peakIdx]
  return (
    <>
      <div className="db-bars h24">
        {hours.map((h) => {
          const total = h.inbound + h.outbound
          return (
            <div
              key={h.hour}
              className="db-bar-col"
              title={`${h.hour} 时 · 客户发 ${h.inbound} · 我发 ${h.outbound}`}
            >
              <div
                className="db-bar-stack"
                style={total > 0 ? { height: `${(total / maxSum) * 100}%` } : undefined}
              >
                <div className="db-bar in" style={{ height: `${pct(h.inbound, total)}%` }} />
                <div className="db-bar out" style={{ height: `${pct(h.outbound, total)}%` }} />
              </div>
              <div className="db-bar-day">{h.hour % 4 === 0 ? h.hour : ''}</div>
            </div>
          )
        })}
      </div>
      {hasData && (
        <div className="db-panel-sub">
          活跃高峰：{peak.hour} 时（共 {sums[peakIdx]} 条，客户发 {peak.inbound}）
        </div>
      )}
    </>
  )
}

/** 消息类型分布 Top（横向进度条） */
function OpsTypes({ items }: { items: OpsTypeCount[] }): React.JSX.Element {
  if (items.length === 0) return <div className="db-empty">范围内暂无消息</div>
  const shown = items.slice(0, 8)
  const max = Math.max(...shown.map((t) => t.count), 1)
  const hidden = items.slice(shown.length).reduce((sum, t) => sum + t.count, 0)
  return (
    <div className="db-types">
      {shown.map((t) => (
        <div className="db-type-row" key={t.label}>
          <span className="db-type-name" title={`${t.label} ${t.count} 条`}>
            {t.label}
          </span>
          <span className="db-type-bar">
            <i style={{ width: `${(t.count / max) * 100}%` }} />
          </span>
          <span className="db-type-count">{t.count}</span>
        </div>
      ))}
      {hidden > 0 && <div className="db-panel-sub">其余 {hidden} 条分属更小类别</div>}
    </div>
  )
}

function DashboardPage(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const source = useWorkbenchStore((s) => s.source)
  const wxid = useWorkbenchStore((s) => s.wxid)
  const gotoSession = useWorkbenchStore((s) => s.gotoSession)
  const refreshSessions = useWorkbenchStore((s) => s.refreshSessions)
  const [sendStatus, setSendStatus] = useState<SendStatusInfo | null>(null)
  const [sendStats, setSendStats] = useState<DayStat[]>([])
  const [overview, setOverview] = useState<SendOverview | null>(null)
  /** 消息运营洞察：聚合结果 + 其对应的账号/区间（避免跨账号/区间闪旧数据） */
  const [ops, setOps] = useState<OpsStats | null>(null)
  const [opsAt, setOpsAt] = useState<{ wxid: string; range: number } | null>(null)
  const [opsError, setOpsError] = useState<string | null>(null)
  const [range, setRange] = useState<7 | 30>(7)
  /** 当前时间（mount 时异步测量，避免渲染期调用 Date.now） */
  const [nowMs, setNowMs] = useState<number>(0)

  useEffect(() => {
    const reply = window.api?.cs?.reply
    if (!reply) return
    void reply
      .getSendStatus()
      .then((st) => {
        setNowMs(Date.now())
        setSendStatus(st)
      })
      .catch(() => undefined)
    void reply
      .stats7d()
      .then(setSendStats)
      .catch(() => undefined)
    void reply
      .overview()
      .then((res) => res?.ok && res.data && setOverview(res.data))
      .catch(() => undefined)
  }, [])

  // ── 消息运营洞察：加载 + 订阅微信库变化自动刷新（主进程已按账号失效统计缓存）──
  useEffect(() => {
    if (source !== 'wx' || !wxid) return
    const wxApi = window.api?.cs?.wx
    if (!wxApi?.opsStats) return
    let cancelled = false
    const load = (): void => {
      void wxApi
        .opsStats(wxid, range)
        .then((res) => {
          if (cancelled) return
          if (res?.ok && res.stats) {
            setOps(res.stats)
            setOpsAt({ wxid, range })
            setOpsError(null)
          } else {
            setOps(null)
            setOpsError(res?.error || '统计失败')
          }
        })
        .catch(() => {
          if (!cancelled) {
            setOps(null)
            setOpsError('统计加载异常')
          }
        })
    }
    load()
    const unsubscribe = wxApi.onDbChanged?.((payload) => {
      if (payload.wxid !== wxid) return
      if (payload.info.sessionChanged) void refreshSessions()
      load()
    })
    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [wxid, source, range, refreshSessions])

  const opsReady = ops !== null && opsAt?.wxid === wxid && opsAt.range === range
  const opsMsg = opsError && !opsReady ? `统计失败：${opsError}` : null
  const opsTotal = ops?.totals.total ?? 0
  const groupMsg = ops?.totals.group ?? 0
  const privateMsg = ops?.totals.privateChat ?? 0
  const opsShare = pct(groupMsg, opsTotal)
  const opsGradient =
    opsTotal > 0 ? `conic-gradient(#5b8ff9 0% ${opsShare}%, #07c160 ${opsShare}% 100%)` : ''
  const resp = ops?.response
  const r30 = resp && resp.samples > 0 ? pct(resp.within30Min, resp.samples) : 0
  const r2h = resp && resp.samples > 0 ? pct(resp.within2h, resp.samples) : 0

  // ── 会话构成（真实：按会话类型标记归类）──
  const comp = useMemo(() => {
    const c = { person: 0, group: 0, official: 0, fold: 0, pinned: 0, collapsed: 0 }
    for (const s of sessions) {
      if (s.isGroup) c.group++
      else if (s.isOfficialAccount) c.official++
      else if (s.isFoldGroup) c.fold++
      else c.person++
      if (s.isPinned) c.pinned++
      if (s.isCollapsed) c.collapsed++
    }
    return c
  }, [sessions])

  const compSegs: CompSegment[] = [
    { key: 'person', label: '个人', color: '#07c160', n: comp.person },
    { key: 'group', label: '群聊', color: '#5b8ff9', n: comp.group },
    { key: 'official', label: '公众号', color: '#f0b429', n: comp.official },
    { key: 'fold', label: '折叠聊天', color: '#e4e6eb', n: comp.fold }
  ].filter((s) => s.n > 0)
  const compTotal = compSegs.reduce((sum, s) => sum + s.n, 0)
  const compGradient = useMemo(() => {
    if (compTotal === 0) return ''
    let acc = 0
    const stops = compSegs.map((s) => {
      const from = acc
      acc += (s.n / compTotal) * 100
      return `${s.color} ${from}% ${acc}%`
    })
    return `conic-gradient(${stops.join(', ')})`
  }, [compSegs, compTotal])

  // ── 跟进队列（真实：unread / lastTimestamp）──
  const canReply = (s: SessionSummary): boolean =>
    !s.isOfficialAccount && !s.isFoldGroup && !s.isWeCom
  /** 待回复队列：有未读，越久未处理越靠前 */
  const followUps = useMemo(
    () =>
      sessions
        .filter((s) => s.unreadCount > 0 && canReply(s))
        .sort((a, b) => a.lastTimestamp - b.lastTimestamp),
    [sessions]
  )
  const overdueCount =
    nowMs > 0 ? followUps.filter((s) => nowMs - s.lastTimestamp > OVERDUE_MS).length : 0
  const needReply = followUps.length

  /** 沉睡召回：近 7~30 天未联系、当前无未读的个人会话 */
  const sleepers = useMemo(
    () =>
      nowMs > 0
        ? sessions
            .filter(
              (s) =>
                canReply(s) &&
                !s.isGroup &&
                s.unreadCount === 0 &&
                s.lastTimestamp > 0 &&
                nowMs - s.lastTimestamp >= SLEEP_MIN_MS &&
                nowMs - s.lastTimestamp <= SLEEP_MAX_MS
            )
            .sort((a, b) => a.lastTimestamp - b.lastTimestamp)
        : [],
    [sessions, nowMs]
  )

  // ── 顶部指标（真实）──
  const todayStart =
    nowMs > 0
      ? (() => {
          const d = new Date(nowMs)
          d.setHours(0, 0, 0, 0)
          return d.getTime()
        })()
      : 0
  const todayActive = sessions.filter(
    (s) =>
      !s.isOfficialAccount &&
      !s.isFoldGroup &&
      s.lastTimestamp >= todayStart &&
      s.lastTimestamp <= nowMs
  ).length

  const nameOf = (sessionId: string): string => {
    const s = sessions.find((x) => x.username === sessionId)
    return s?.displayName || sessionId
  }

  // ── 发送监控（真实 send_log）──
  const totals = overview?.totals ?? {}
  const verifiedRate = overview?.verifiedRate ?? null
  const verifiedPct = verifiedRate === null ? null : Math.round(verifiedRate * 100)

  const maxVolume = Math.max(...sendStats.map((d) => d.sent + d.failed), 1)
  const sendRatio = sendStatus
    ? Math.min(100, Math.round((sendStatus.todayCount / Math.max(sendStatus.dailyLimit, 1)) * 100))
    : 0

  return (
    <div className="page-scroll">
      <h2 className="page-title">数据看板</h2>
      <div className="page-subtitle">
        {source === 'wx' ? '会话与消息指标来自真实微信库' : '未连接微信数据'} ·
        发送统计为真实审计数据（send_log）
      </div>

      {sendStatus?.halted && (
        <div className="db-alert">
          发送通道已熔断（连续校验失败），自动/人工发送均已暂停，请到「设置」页检查并复位。
        </div>
      )}

      {/* 顶部运营指标带 */}
      <div className="db-cards">
        <div className="db-card page-card">
          <div className="db-card-num">{sessions.length}</div>
          <div className="db-card-label">总会话数</div>
        </div>
        <div className="db-card page-card">
          <div className={`db-card-num${needReply > 0 ? ' warn' : ''}`}>{needReply}</div>
          <div className="db-card-label">待回复会话</div>
        </div>
        <div className="db-card page-card">
          <div className={`db-card-num${overdueCount > 0 ? ' warn' : ''}`}>{overdueCount}</div>
          <div className="db-card-label">超时未回（2h+）</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num">{todayActive}</div>
          <div className="db-card-label">今日互动会话</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num">{sendStatus?.todayCount ?? '—'}</div>
          <div className="db-card-label">今日已发送</div>
        </div>
      </div>

      {/* 跟进队列 */}
      <div className="db-grid">
        <div className="page-card db-panel">
          <div className="db-panel-title">
            待回复队列
            {needReply > 0 && <span className="db-count-badge">{needReply}</span>}
          </div>
          {followUps.length === 0 ? (
            <div className="db-empty">暂无待回复会话，全部跟进完毕</div>
          ) : (
            <div className="db-q-scroll">
              {followUps.slice(0, QUEUE_SHOW).map((s) => {
                const overdue = nowMs > 0 && nowMs - s.lastTimestamp > OVERDUE_MS
                return (
                  <div
                    key={s.username}
                    className="db-q-item"
                    onClick={() => source === 'wx' && gotoSession(s.username)}
                  >
                    <span className="cu-avatar" style={{ background: avatarColor(s.displayName) }}>
                      {s.displayName.slice(0, 1)}
                    </span>
                    <div className="db-q-main">
                      <div className="db-q-name">
                        <span className="db-q-name-text">{s.displayName}</span>
                        {s.unreadCount > 0 && <span className="db-q-badge">{s.unreadCount}</span>}
                      </div>
                      <div className="db-q-sub">{s.summary}</div>
                    </div>
                    <span className={`db-q-time${overdue ? ' is-overdue' : ''}`}>
                      {fmtAge(nowMs, s.lastTimestamp)}
                    </span>
                  </div>
                )
              })}
              {followUps.length > QUEUE_SHOW && (
                <div className="db-q-more">
                  另有 {followUps.length - QUEUE_SHOW} 个会话，请在对话页处理
                </div>
              )}
            </div>
          )}
        </div>

        <div className="page-card db-panel">
          <div className="db-panel-title">
            沉睡召回（近 7~30 天）
            {sleepers.length > 0 && (
              <span className="db-count-badge is-sleep">{sleepers.length}</span>
            )}
          </div>
          {nowMs === 0 ? (
            <div className="db-empty">统计中…</div>
          ) : sleepers.length === 0 ? (
            <div className="db-empty">暂无沉睡个人会话，可保持活跃</div>
          ) : (
            <div className="db-q-scroll">
              {sleepers.slice(0, QUEUE_SHOW).map((s) => (
                <div
                  key={s.username}
                  className="db-q-item"
                  onClick={() => source === 'wx' && gotoSession(s.username)}
                >
                  <span className="cu-avatar" style={{ background: avatarColor(s.displayName) }}>
                    {s.displayName.slice(0, 1)}
                  </span>
                  <div className="db-q-main">
                    <div className="db-q-name">
                      <span className="db-q-name-text">{s.displayName}</span>
                    </div>
                    <div className="db-q-sub">{s.summary || '无消息记录'}</div>
                  </div>
                  <span className="db-q-time">{fmtAge(nowMs, s.lastTimestamp)}</span>
                </div>
              ))}
              {sleepers.length > QUEUE_SHOW && (
                <div className="db-q-more">另有 {sleepers.length - QUEUE_SHOW} 个沉睡客户</div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="db-grid">
        {/* 会话构成（真实） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">会话构成</div>
          {compTotal === 0 ? (
            <div className="db-empty">
              {source === 'wx' ? '暂无会话数据' : '连接微信数据后展示'}
            </div>
          ) : (
            <div className="db-donut-row">
              <div className="db-donut" style={{ background: compGradient }}>
                <div className="db-donut-hole">
                  <div>{compTotal}</div>
                  <small>会话</small>
                </div>
              </div>
              <div className="db-legend">
                {compSegs.map((s) => (
                  <div key={s.key} className="db-legend-item">
                    <span className="db-dot" style={{ background: s.color }} />
                    {s.label} {s.n} 个
                  </div>
                ))}
                {(comp.pinned > 0 || comp.collapsed > 0) && (
                  <div className="db-comp-note">
                    置顶 {comp.pinned} · 折叠 {comp.collapsed}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* 发送监控（真实） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">发送监控（近 7 日）</div>
          <div className="db-freq">
            <div className="db-freq-row">
              <span>今日频控</span>
              <span>
                {sendStatus ? `${sendStatus.todayCount} / ${sendStatus.dailyLimit}` : '—'}
              </span>
            </div>
            <div className="db-freq-bar">
              <div
                className={`db-freq-fill${sendRatio > 80 ? ' is-high' : ''}`}
                style={{ width: `${sendRatio}%` }}
              />
            </div>
            {sendStatus && sendStatus.queued > 0 && (
              <div className="db-freq-note">队列中等待 {sendStatus.queued} 条</div>
            )}
          </div>
          {sendStats.length === 0 ? (
            <div className="db-empty">暂无发送记录</div>
          ) : (
            <>
              <div className="db-bars sm">
                {sendStats.map((d) => (
                  <div key={d.day} className="db-bar-col">
                    <div className="db-bar-val">{d.sent + d.failed}</div>
                    <div
                      className="db-bar-stack"
                      style={{ height: `${((d.sent + d.failed) / maxVolume) * 100}%` }}
                    >
                      <div
                        className="db-bar fail"
                        style={{
                          height:
                            d.sent + d.failed > 0 ? `${(d.failed / (d.sent + d.failed)) * 100}%` : 0
                        }}
                      />
                      <div
                        className="db-bar sent"
                        style={{
                          height:
                            d.sent + d.failed > 0 ? `${(d.sent / (d.sent + d.failed)) * 100}%` : 0
                        }}
                      />
                    </div>
                    <div className="db-bar-day">{d.day}</div>
                  </div>
                ))}
              </div>
              <div className="db-legend">
                <div className="db-legend-item">
                  <span className="db-dot sent" />
                  成功
                </div>
                <div className="db-legend-item">
                  <span className="db-dot fail" />
                  失败/拦截
                </div>
              </div>
            </>
          )}
        </div>

        {/* 发送质量（真实） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">发送质量（近 7 日）</div>
          <div className="db-freq">
            {Object.keys(totals).length === 0 ? (
              <div className="db-empty">暂无发送记录</div>
            ) : (
              <>
                <div className="db-freq-row">
                  <span>闭环校验通过率</span>
                  <span>{verifiedPct === null ? '—' : `${verifiedPct}%`}</span>
                </div>
                <div className="db-freq-bar">
                  {verifiedPct !== null && (
                    <div
                      className={`db-freq-fill${verifiedPct < 90 ? ' is-high' : ''}`}
                      style={{ width: `${verifiedPct}%` }}
                    />
                  )}
                </div>
                {verifiedPct !== null && verifiedPct < 100 && (
                  <div className="db-freq-note">部分成功消息尚未被微信库校验确认</div>
                )}
                <div className="db-send-breakdown">
                  {Object.entries(RESULT_LABEL)
                    .filter(([k]) => (totals[k] ?? 0) > 0)
                    .map(([k, label]) => (
                      <span key={k} className={`db-chip db-chip-${k}`}>
                        {label} {totals[k]}
                      </span>
                    ))}
                </div>
              </>
            )}
          </div>
          <div className="db-panel-sub">失败原因 Top</div>
          {overview && overview.failReasons.length === 0 ? (
            <div className="db-empty">近 7 日无失败记录</div>
          ) : (
            <div className="db-reasons">
              {(overview?.failReasons ?? []).map((r, i) => (
                <div className="db-reason" key={i}>
                  <span className="db-reason-name">
                    {i + 1}. {r.reason}
                  </span>
                  <span className="db-reason-count">{r.count}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 发送对象 Top（真实） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">发送对象 Top 5（近 7 日）</div>
          {!overview || overview.topTargets.length === 0 ? (
            <div className="db-empty">近 7 日暂无发送记录</div>
          ) : (
            <div className="db-top-list">
              {overview.topTargets.map((t, i) => {
                const name = nameOf(t.sessionId)
                return (
                  <div
                    key={t.sessionId}
                    className="db-top-item"
                    onClick={() => source === 'wx' && gotoSession(t.sessionId)}
                  >
                    <span className="db-top-rank">{i + 1}</span>
                    <span className="cu-avatar" style={{ background: avatarColor(name) }}>
                      {name.slice(0, 1)}
                    </span>
                    <span className="db-top-name" title={t.sessionId}>
                      {name}
                    </span>
                    <span className="db-top-score">{t.sent} 条</span>
                    {t.failed > 0 && <span className="db-top-score fail">{t.failed} 失败</span>}
                  </div>
                )
              })}
            </div>
          )}
        </div>
      </div>

      {/* 消息运营洞察（真实微信消息库聚合） */}
      <div className="db-sec">
        <div className="db-sec-head">
          <span className="db-panel-title db-sec-title">
            消息运营洞察
            <span className="db-panel-hint">真实微信消息库</span>
          </span>
          {source === 'wx' && (
            <span className="db-seg">
              <button
                type="button"
                className={`db-seg-btn${range === 7 ? ' on' : ''}`}
                onClick={() => setRange(7)}
              >
                近 7 日
              </button>
              <button
                type="button"
                className={`db-seg-btn${range === 30 ? ' on' : ''}`}
                onClick={() => setRange(30)}
              >
                近 30 日
              </button>
            </span>
          )}
        </div>

        {source !== 'wx' ? (
          <div className="page-card db-panel">
            <div className="db-empty">
              连接微信数据后展示消息运营洞察（收发趋势 / 时段分布 / 消息类型 / 红包 / 响应时效）
            </div>
          </div>
        ) : !opsReady ? (
          <div className="page-card db-panel">
            <div className="db-empty">{opsMsg ?? '正在聚合消息统计…'}</div>
          </div>
        ) : ops ? (
          <>
            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-title">每日收发趋势</div>
                <OpsTrend points={ops.trend} />
                <div className="db-legend">
                  <span className="db-legend-item">
                    <span className="db-dot in" />
                    客户发
                  </span>
                  <span className="db-legend-item">
                    <span className="db-dot out" />
                    我回复
                  </span>
                </div>
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-title">24 小时时段分布</div>
                <OpsHours hours={ops.hours} />
              </div>
            </div>

            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-title">消息类型分布</div>
                <OpsTypes items={ops.typeDist} />
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-title">群聊 / 私聊分布</div>
                {opsTotal === 0 ? (
                  <div className="db-empty">范围内暂无消息</div>
                ) : (
                  <div className="db-donut-row">
                    <div className="db-donut sm" style={{ background: opsGradient }}>
                      <div className="db-donut-hole">
                        <div>{opsShare}%</div>
                        <small>群消息占比</small>
                      </div>
                    </div>
                    <div className="db-legend">
                      <div className="db-legend-item">
                        <span className="db-dot" style={{ background: '#5b8ff9' }} />
                        群聊 {groupMsg} 条 · {opsShare}%
                      </div>
                      <div className="db-legend-item">
                        <span className="db-dot" style={{ background: '#07c160' }} />
                        私聊/个人 {privateMsg} 条 · {100 - opsShare}%
                      </div>
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="db-grid">
              <div className="page-card db-panel">
                <div className="db-panel-title">服务响应时效</div>
                {resp && resp.samples > 0 ? (
                  <div className="db-freq">
                    <div className="db-freq-row">
                      <span>有效样本</span>
                      <span>{resp.samples} 次回复</span>
                    </div>
                    <div className="db-freq-row">
                      <span>30 分钟内回复</span>
                      <span>{r30}%</span>
                    </div>
                    <div className="db-freq-bar">
                      <div className="db-freq-fill" style={{ width: `${r30}%` }} />
                    </div>
                    <div className="db-freq-row">
                      <span>2 小时内回复</span>
                      <span>{r2h}%</span>
                    </div>
                    <div className="db-freq-bar">
                      <div className="db-freq-fill" style={{ width: `${r2h}%` }} />
                    </div>
                    <div className="db-freq-row">
                      <span>中位响应时长</span>
                      <span>
                        {resp.medianMinutes === null ? '—' : `${resp.medianMinutes} 分钟`}
                      </span>
                    </div>
                    <div className="db-freq-row">
                      <span>超 2h 未回待跟进</span>
                      <span className={resp.noResponse > 0 ? 'db-text-warn' : ''}>
                        {resp.noResponse}
                      </span>
                    </div>
                  </div>
                ) : (
                  <div className="db-empty">范围内缺少「客户先发 → 我回复」的会话样本</div>
                )}
              </div>
              <div className="page-card db-panel">
                <div className="db-panel-title">红包往来</div>
                <div className="ops-rp">
                  <div className="ops-rp-item">
                    <div className="ops-rp-num">{ops.redPackets.sent}</div>
                    <div className="db-card-label">我发出</div>
                  </div>
                  <div className="ops-rp-item">
                    <div className="ops-rp-num">{ops.redPackets.received}</div>
                    <div className="db-card-label">我收到</div>
                  </div>
                  <div className="ops-rp-item">
                    <div className="ops-rp-num">{ops.redPackets.claimReceipts}</div>
                    <div className="db-card-label">被领取回执</div>
                  </div>
                </div>
                <div className="db-comp-note">
                  口径：按消息条数统计；红包金额、领取人不在本地可读范围，回执来自系统消息「红包已被领取」。
                </div>
              </div>
            </div>
          </>
        ) : null}
      </div>

      <div className="page-subtitle db-footnote">
        口径：待回复=有未读（不含公众号/折叠）；超时未回=有未读且最后消息距今超 2
        小时；今日互动=今日有消息的会话；沉睡=近 7~30 天未联系的个人会话。
      </div>
    </div>
  )
}

export default DashboardPage
