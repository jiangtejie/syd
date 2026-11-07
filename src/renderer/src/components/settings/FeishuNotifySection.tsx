import { useEffect, useState } from 'react'
import { SwitchRow } from './ui'
import { ContactPicker } from './ContactPicker'
import { toast } from '../../stores/toast'
import { useWorkbenchStore } from '../../stores/workbench'

/**
 * 飞书通知(告警推送)配置:目标(群/个人)、事件开关、测试发送与最近记录。
 * 发送身份固定为机器人(复用 IM 渠道或「飞书云文档」里的应用凭证)。
 */

interface NotifyTarget {
  kind: 'chat' | 'user'
  id: string
  name: string
}

interface NotifyConfig {
  enabled: boolean
  targets: NotifyTarget[]
  events: string[]
  dailyLimit: number
}

interface DigestConfig {
  enabled: boolean
  time: string
  includeAgent: boolean
  lastDate: string
  targets: number
}

interface RecentRow {
  id: number
  targetKind: string
  targetId: string
  targetName: string
  content: string
  source: string
  result: string
  error?: string
  createdAt: number
}

const api = window.api?.cs?.feishuNotify

function fmt(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export function FeishuNotifySection(): React.JSX.Element {
  const [config, setConfig] = useState<NotifyConfig | null>(null)
  const [cred, setCred] = useState<{ configured: boolean; label: string } | null>(null)
  const [recent, setRecent] = useState<RecentRow[]>([])
  const [busy, setBusy] = useState(false)
  const [kind, setKind] = useState<'chat' | 'user'>('chat')
  const [email, setEmail] = useState('')
  const [resolved, setResolved] = useState<{ openId: string; name: string } | null>(null)
  const [chats, setChats] = useState<Array<{ chatId: string; name: string }> | null>(null)
  /** 每日日报（独立开关，共用上面的接收目标） */
  const [digest, setDigest] = useState<DigestConfig | null>(null)
  const [digestPreview, setDigestPreview] = useState('')
  const [digestBusy, setDigestBusy] = useState('')
  const [chatPick, setChatPick] = useState('')
  const [err, setErr] = useState('')

  type LoadRes = Awaited<ReturnType<NonNullable<typeof api>['get']>> | null

  const applyRes = (res: LoadRes): void => {
    if (!res?.ok) {
      setErr(res?.error ?? '读取飞书通知配置失败')
      return
    }
    setErr('')
    if (res.config) setConfig(res.config)
    if (res.credential) {
      setCred({
        configured: !!res.credential.configured,
        label: res.credential.configured
          ? res.credential.source === 'im'
            ? `复用 IM 渠道账号「${res.credential.accountName ?? '飞书机器人'}」`
            : '设置页凭证'
          : '未配置'
      })
    }
    setRecent(res.recent ?? [])
  }

  const load = async (): Promise<void> => {
    applyRes(await api?.get().catch(() => null))
  }

  useEffect(() => {
    let alive = true
    void api
      ?.get()
      .then((res) => {
        if (alive) applyRes(res)
      })
      .catch(() => undefined)
    void api
      ?.digestGet()
      .then((res) => {
        if (alive && res?.ok && res.config) setDigest(res.config)
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅首次挂载读取一次
  }, [])

  const patchDigest = async (patch: {
    enabled?: boolean
    time?: string
    includeAgent?: boolean
  }): Promise<void> => {
    const r = await api?.digestSet(patch).catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '保存失败')
      if (r?.config) setDigest(r.config)
      return
    }
    if (r.config) setDigest(r.config)
  }

  const sendDigest = async (): Promise<void> => {
    const wxid = useWorkbenchStore.getState().wxid
    setDigestBusy('send')
    try {
      const r = await api?.digestSend(wxid ?? '', false).catch(() => null)
      if (!r) {
        toast.error('发送失败')
        return
      }
      if (r.config) setDigest(r.config)
      setDigestPreview(r.text ?? '')
      if (!r.ok) toast.error(r.error || '发送失败（先在下面添加接收目标）')
      else toast.success(`日报已发送到 ${r.sent} 个目标`)
    } finally {
      setDigestBusy('')
    }
  }

  const onToggleEnabled = async (on: boolean): Promise<void> => {
    const r = await api?.setEnabled(on).catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '保存失败')
      return
    }
    toast.success(on ? '已开启飞书告警推送' : '已关闭飞书告警推送')
    await load()
  }

  const onToggleEvent = async (evt: string, on: boolean): Promise<void> => {
    const r = await api?.setEvent(evt, on).catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '保存失败')
      return
    }
    await load()
  }

  const loadChats = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api?.listChats().catch(() => null)
      if (!r?.ok) {
        toast.error(r?.error || '获取群列表失败')
        return
      }
      setChats(r.chats ?? [])
      if ((r.chats ?? []).length === 0) toast.error('机器人尚未加入任何群: 先把机器人拉进目标群')
    } finally {
      setBusy(false)
    }
  }

  const addChat = async (): Promise<void> => {
    const hit = (chats ?? []).find((c) => c.chatId === chatPick)
    if (!hit) {
      toast.error('请先选择群')
      return
    }
    const r = await api
      ?.addTarget({ kind: 'chat', id: hit.chatId, name: hit.name })
      .catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '添加失败')
      return
    }
    toast.success(`已添加群「${hit.name}」`)
    setChatPick('')
    setChats(null)
    await load()
  }

  const resolveEmail = async (): Promise<void> => {
    if (!email.trim()) {
      toast.error('请填写邮箱')
      return
    }
    setBusy(true)
    try {
      const r = await api?.resolveUser(email.trim()).catch(() => null)
      if (!r) {
        toast.error('解析失败')
        return
      }
      if (!r.ok) {
        toast.error(r.error || '解析失败')
        return
      }
      if (!r.openId) {
        toast.error('未找到该邮箱对应的飞书用户')
        return
      }
      setResolved({ openId: r.openId, name: email.trim() })
      toast.success('已解析到飞书用户')
    } finally {
      setBusy(false)
    }
  }

  const addUser = async (): Promise<void> => {
    if (!resolved) return
    const r = await api
      ?.addTarget({ kind: 'user', id: resolved.openId, name: resolved.name })
      .catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '添加失败')
      return
    }
    toast.success(`已添加接收人「${resolved.name}」`)
    setResolved(null)
    setEmail('')
    await load()
  }

  const addContact = async (u: { openId: string; name: string }): Promise<void> => {
    const r = await api?.addTarget({ kind: 'user', id: u.openId, name: u.name }).catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '添加失败')
      return
    }
    toast.success(`已添加接收人「${u.name}」`)
    await load()
  }

  const removeTarget = async (t: NotifyTarget): Promise<void> => {
    const r = await api?.removeTarget(t.kind, t.id).catch(() => null)
    if (!r?.ok) {
      toast.error(r?.error || '删除失败')
      return
    }
    await load()
  }

  const sendTest = async (): Promise<void> => {
    setBusy(true)
    try {
      const r = await api?.test().catch(() => null)
      if (!r?.ok) {
        toast.error(r?.error || '发送失败')
        return
      }
      toast.success(`测试消息已发送(${r.sent ?? 1} 个目标)`)
      await load()
    } finally {
      setBusy(false)
    }
  }

  const events = config?.events ?? []

  return (
    <div className="st-grid wb-skills-full">
      <div className="st-hint">
        应用凭证:{cred ? cred.label : '读取中…'}
        {cred && !cred.configured
          ? ' —— 请先在 设置 → AI 助手 → 飞书云文档 填写,或在 设置 → IM 渠道 接入飞书机器人'
          : ''}
      </div>
      {err && <div className="st-bad">✗ {err}</div>}

      <SwitchRow
        label="启用飞书告警推送"
        desc="开启后,新问题与盯办提醒会通过机器人推送到下面的接收目标(只推必要信息,可在下方关闭单类事件)。"
        checked={!!config?.enabled}
        onChange={(v) => void onToggleEnabled(v)}
      />
      <SwitchRow
        label="新问题"
        desc="后台增量分析发现新问题时推送(同一群 20 分钟内不重复)。"
        checked={events.includes('issue_new')}
        onChange={(v) => void onToggleEvent('issue_new', v)}
      />
      <SwitchRow
        label="盯办提醒"
        desc="紧急问题未指派超时、其他问题未指派超时或跟进超时推送(同一条问题 45 分钟内不重复)。"
        checked={events.includes('issue_escalate')}
        onChange={(v) => void onToggleEvent('issue_escalate', v)}
      />

      {/* 每日日报：与实时告警分开开关（有人只想要日报），共用上面的接收目标 */}
      <div className="st-subtitle">每日日报</div>
      <SwitchRow
        label="每天定时推送日报"
        desc="到点把「昨日新增/已解决 · 待处理 · 无人应 · 积压最久」推到上面的接收目标；与实时告警互不影响，也没有待办时照发一条（用来确认定时任务没死）。"
        checked={!!digest?.enabled}
        onChange={(v) => void patchDigest({ enabled: v })}
      />
      <div className="st-actions">
        <span className="st-hint">推送时间</span>
        <input
          className="st-input st-input-time"
          value={digest?.time ?? '09:00'}
          placeholder="09:00"
          onChange={(e) => setDigest((d) => (d ? { ...d, time: e.target.value } : d))}
          onBlur={(e) => void patchDigest({ time: e.target.value })}
          title="24 小时制，HH:mm"
        />
        <button
          type="button"
          className="ui-btn"
          disabled={digestBusy !== ''}
          onClick={() => void sendDigest()}
        >
          {digestBusy === 'send' ? '发送中…' : '立即发一条看看'}
        </button>
      </div>
      <SwitchRow
        label="日报里附数字员工统计"
        desc="附一行「影子模式：命中话术 / 转人工 / 未命中 / 话术覆盖率」，方便判断话术该补哪些。"
        checked={digest?.includeAgent ?? true}
        onChange={(v) => void patchDigest({ includeAgent: v })}
      />
      {digest && digest.targets === 0 && (
        <div className="st-hint">
          ⚠ 还没有接收目标：日报发不出去，请先在上面「接收目标」里加一个群或同事。
        </div>
      )}
      {digest?.lastDate && <div className="st-hint">上次发送：{digest.lastDate}</div>}
      {digestPreview && <pre className="st-hint st-preview">{digestPreview}</pre>}

      <div className="st-subtitle">接收目标({config?.targets.length ?? 0})</div>
      <div className="im-list">
        {(config?.targets ?? []).length === 0 && (
          <div className="st-hint">还没有接收目标:添加一个群或一个同事。</div>
        )}
        {(config?.targets ?? []).map((t) => (
          <div key={`${t.kind}:${t.id}`} className="mcp-item">
            <div className="mcp-item-main">
              <b>{t.name}</b>
              <span className="mcp-kind">{t.kind === 'chat' ? '群' : '个人'}</span>
              <span className="mcp-desc">{t.id}</span>
            </div>
            <div className="mcp-item-ops">
              <button
                type="button"
                className="ui-btn is-danger is-sm"
                onClick={() => void removeTarget(t)}
              >
                移除
              </button>
            </div>
          </div>
        ))}
      </div>

      <div className="im-kind-pick">
        {(['chat', 'user'] as const).map((k) => (
          <button
            key={k}
            type="button"
            className={`im-kind-btn${kind === k ? ' is-on' : ''}`}
            onClick={() => setKind(k)}
          >
            {k === 'chat' ? '加群' : '加同事'}
          </button>
        ))}
      </div>

      {kind === 'chat' ? (
        <div className="st-actions">
          <button type="button" className="ui-btn" disabled={busy} onClick={() => void loadChats()}>
            {busy ? '读取中…' : '读取机器人所在群'}
          </button>
          {chats && (
            <>
              <select
                className="st-input"
                value={chatPick}
                onChange={(e) => setChatPick(e.target.value)}
              >
                <option value="">选择群…</option>
                {chats.map((c) => (
                  <option key={c.chatId} value={c.chatId}>
                    {c.name}
                  </option>
                ))}
              </select>
              <button type="button" className="ui-btn is-primary" onClick={() => void addChat()}>
                添加
              </button>
            </>
          )}
        </div>
      ) : (
        <>
          <ContactPicker onPick={(u) => void addContact(u)} withDepartments />

          <div className="st-actions">
            <input
              className="st-input"
              value={email}
              placeholder="同事邮箱(需为个人邮箱)"
              onChange={(e) => setEmail(e.target.value)}
            />
            <button
              type="button"
              className="ui-btn"
              disabled={busy}
              onClick={() => void resolveEmail()}
            >
              解析
            </button>
            {resolved && (
              <button type="button" className="ui-btn is-primary" onClick={() => void addUser()}>
                添加 {resolved.name}
              </button>
            )}
          </div>
          <div className="st-hint">
            邮箱解析需应用开通 contact:user.id:readonly 并发布版本;若暂未开通,可直接把同事的
            open_id(ou_…)填进输入框后点「解析」。
          </div>
        </>
      )}

      <div className="st-actions">
        <button
          type="button"
          className="ui-btn is-primary"
          disabled={busy}
          onClick={() => void sendTest()}
        >
          {busy ? '发送中…' : '发送测试消息'}
        </button>
      </div>

      {recent.length > 0 && (
        <>
          <div className="st-subtitle">最近发送</div>
          <div className="im-list">
            {recent.map((r) => (
              <div key={r.id} className="mcp-item">
                <div className="mcp-item-main">
                  <span className={r.result === 'ok' ? 'mcp-on' : 'mcp-off'}>
                    {r.result === 'ok' ? '成功' : '失败'}
                  </span>
                  <b>{r.targetName}</b>
                  <span className="mcp-desc">
                    {fmt(r.createdAt)} · {r.source}
                    {r.error ? ` · ${r.error.slice(0, 60)}` : ''}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}
