import { useEffect, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { avatarColor } from '../lib/ui'
import { deriveCustomers, seededRandom } from '../lib/customers'
import type { SendStatusInfo } from '../../../shared/types'
import './dashboard.css'

/**
 * 数据看板：运营指标 + 趋势图 + 客户分层 + 发送监控。
 * 发送相关数据为真实 send_log；消息量趋势/活跃度为示例算法（页面已标注）。
 */

interface DayStat {
  day: string
  sent: number
  failed: number
}

/** 近 7 日消息量（示例：按日期种子确定性生成，解密层接入后替换为真实统计） */
function mockMessageVolume(): Array<{ day: string; count: number }> {
  const out: Array<{ day: string; count: number }> = []
  for (let i = 6; i >= 0; i--) {
    const d = new Date()
    d.setDate(d.getDate() - i)
    const seed = d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate()
    out.push({
      day: `${d.getMonth() + 1}/${d.getDate()}`,
      count: Math.floor(20 + seededRandom(seed) * 60)
    })
  }
  return out
}

function DashboardPage(): React.JSX.Element {
  const sessions = useWorkbenchStore((s) => s.sessions)
  const source = useWorkbenchStore((s) => s.source)
  const gotoSession = useWorkbenchStore((s) => s.gotoSession)
  const [sendStatus, setSendStatus] = useState<SendStatusInfo | null>(null)
  const [sendStats, setSendStats] = useState<DayStat[]>([])

  const customers = useMemo(() => deriveCustomers(sessions), [sessions])
  const msgVolume = useMemo(mockMessageVolume, [])

  useEffect(() => {
    const reply = window.api?.cs?.reply
    if (!reply) return
    void reply.getSendStatus().then(setSendStatus).catch(() => undefined)
    void reply.stats7d().then(setSendStats).catch(() => undefined)
  }, [])

  const totalUnread = sessions.reduce((n, s) => n + s.unreadCount, 0)
  const needReply = sessions.filter((s) => s.unreadCount > 0).length
  const vipCount = customers.filter((c) => c.tier === 'vip').length
  const vipRatio = customers.length > 0 ? Math.round((vipCount / customers.length) * 100) : 0
  const topActive = [...customers].sort((a, b) => b.activeScore - a.activeScore).slice(0, 5)

  const maxVolume = Math.max(...msgVolume.map((d) => d.count), 1)
  const maxSent = Math.max(...sendStats.map((d) => d.sent + d.failed), 1)
  const sendRatio = sendStatus
    ? Math.min(100, Math.round((sendStatus.todayCount / Math.max(sendStatus.dailyLimit, 1)) * 100))
    : 0

  return (
    <div className="page-scroll">
      <h2 className="page-title">数据看板</h2>
      <div className="page-subtitle">
        {source === 'wx' ? '真实微信数据' : '未连接微信数据'} · 发送统计为真实审计数据
      </div>

      {sendStatus?.halted && (
        <div className="db-alert">
          发送通道已熔断（连续校验失败），自动/人工发送均已暂停，请到「设置」页检查并复位。
        </div>
      )}

      {/* 指标卡 */}
      <div className="db-cards">
        <div className="db-card page-card">
          <div className="db-card-num">{sessions.length}</div>
          <div className="db-card-label">总会话数</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num warn">{totalUnread}</div>
          <div className="db-card-label">未读消息</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num">{needReply}</div>
          <div className="db-card-label">待回复会话</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num vip">{vipCount}</div>
          <div className="db-card-label">VIP 客户</div>
        </div>
        <div className="db-card page-card">
          <div className="db-card-num">{sendStatus?.todayCount ?? '—'}</div>
          <div className="db-card-label">今日已发送</div>
        </div>
      </div>

      <div className="db-grid">
        {/* 消息量趋势（示例） */}
        <div className="page-card db-panel">
          <div className="db-panel-title">
            近 7 日消息量
            <span className="db-panel-hint">示例数据</span>
          </div>
          <div className="db-bars">
            {msgVolume.map((d) => (
              <div key={d.day} className="db-bar-col">
                <div className="db-bar-val">{d.count}</div>
                <div className="db-bar" style={{ height: `${(d.count / maxVolume) * 100}%` }} />
                <div className="db-bar-day">{d.day}</div>
              </div>
            ))}
          </div>
        </div>

        {/* 客户分层 */}
        <div className="page-card db-panel">
          <div className="db-panel-title">客户分层</div>
          <div className="db-donut-row">
            <div
              className="db-donut"
              style={{
                background: `conic-gradient(#f0b429 0 ${vipRatio}%, #e4e6eb ${vipRatio}% 100%)`
              }}
            >
              <div className="db-donut-hole">{vipRatio}%</div>
            </div>
            <div className="db-legend">
              <div className="db-legend-item">
                <span className="db-dot vip" />
                VIP {vipCount} 位
              </div>
              <div className="db-legend-item">
                <span className="db-dot normal" />
                普通 {customers.length - vipCount} 位
              </div>
            </div>
          </div>
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
          <div className="db-bars sm">
            {sendStats.map((d) => (
              <div key={d.day} className="db-bar-col">
                <div className="db-bar-val">{d.sent + d.failed}</div>
                <div className="db-bar-stack" style={{ height: `${((d.sent + d.failed) / maxSent) * 100}%` }}>
                  <div className="db-bar fail" style={{ height: d.sent + d.failed > 0 ? `${(d.failed / (d.sent + d.failed)) * 100}%` : 0 }} />
                  <div className="db-bar sent" style={{ height: d.sent + d.failed > 0 ? `${(d.sent / (d.sent + d.failed)) * 100}%` : 0 }} />
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
              失败
            </div>
          </div>
        </div>

        {/* 活跃客户 Top5 */}
        <div className="page-card db-panel">
          <div className="db-panel-title">活跃客户 Top 5</div>
          <div className="db-top-list">
            {topActive.map((c, i) => (
              <div key={c.wxid} className="db-top-item" onClick={() => gotoSession(c.wxid)}>
                <span className="db-top-rank">{i + 1}</span>
                <span className="cu-avatar" style={{ background: avatarColor(c.name) }}>
                  {c.name.slice(0, 1)}
                </span>
                <span className="db-top-name">
                  {c.name}
                  {c.tier === 'vip' && <span className="cu-tier">VIP</span>}
                </span>
                <span className="db-top-score">{c.activeScore}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

export default DashboardPage
