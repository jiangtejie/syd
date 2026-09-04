import { useEffect, useState } from 'react'
import type { ImChannelAccount, ImChannelAccountInput } from '../../../shared/types'
import { toast } from '../stores/toast'
import './im.css'

/**
 * IM 渠道页(一期:飞书机器人)。
 * 机器人 = 本产品 AI 助手(复用记忆/工具/ReAct)通过飞书 WebSocket 长连接收发;
 * 私聊直接响应,群聊需 @;凭证 AppSecret 以系统加密存储。
 */

const imApi = window.api?.cs?.im

export default function ImPage(): React.JSX.Element {
  const [accounts, setAccounts] = useState<ImChannelAccount[] | null>(null)
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<ImChannelAccountInput>({
    name: '',
    channel: 'feishu',
    appId: '',
    appSecret: '',
    enabled: false
  })
  const [editId, setEditId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    const res = await imApi?.list().catch(() => null)
    if (res?.ok && res.accounts) setAccounts(res.accounts as ImChannelAccount[])
    else setAccounts([])
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取 IM 账号(全仓同款模式)
    void load()
  }, [])

  // 主进程推送的连接状态变化(连接成功/失败/重连)实时刷新列表
  useEffect(() => {
    if (!imApi?.onStatus) return
    const off = imApi.onStatus((p) => {
      setAccounts(
        (prev) =>
          prev &&
          prev.map((a) =>
            a.id === p.accountId
              ? {
                  ...a,
                  status: (p.status as ImChannelAccount['status']) ?? a.status,
                  statusText: p.statusText
                }
              : a
          )
      )
    })
    return off
  }, [])

  const startNew = (): void => {
    setEditId(null)
    setForm({ name: '', channel: 'feishu', appId: '', appSecret: '', enabled: true })
    setOpen(true)
  }
  const editAccount = (a: ImChannelAccount): void => {
    setEditId(a.id)
    // 编辑时 secret 需重新输入(不会回显)
    setForm({
      id: a.id,
      name: a.name,
      channel: 'feishu',
      appId: '',
      appSecret: '',
      enabled: a.enabled
    })
    setOpen(true)
  }
  const save = async (): Promise<void> => {
    setSaving(true)
    try {
      const res = await imApi?.save(form).catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '保存失败')
        return
      }
      // 账号已保存,但自动连接失败时给出原因(如凭证/订阅配置问题)
      if (res.error) toast.error(`已保存,但连接失败:${res.error}`)
      else toast.success('账号已保存')
      setOpen(false)
      await load()
    } finally {
      setSaving(false)
    }
  }
  const remove = async (a: ImChannelAccount): Promise<void> => {
    if (!window.confirm(`删除 IM 账号「${a.name}」?`)) return
    const res = await imApi?.remove(a.id).catch(() => null)
    if (res?.ok) {
      toast.success('已删除')
      await load()
    } else {
      toast.error((res as { error?: string } | null)?.error || '删除失败')
    }
  }
  const toggle = async (a: ImChannelAccount): Promise<void> => {
    const res = await imApi?.toggle(a.id, !a.enabled).catch(() => null)
    if (res?.ok) {
      toast.success(!a.enabled ? '已启用,正在连接…' : '已停用')
      await load()
    } else {
      toast.error((res as { error?: string } | null)?.error || '操作失败')
    }
  }

  return (
    <div className="page-scroll im-page">
      <div className="im-head">
        <h2 className="page-title">IM 渠道</h2>
        <button type="button" className="st-btn" onClick={startNew}>
          ＋ 接入飞书机器人
        </button>
      </div>

      <div className="im-guide">
        接入前需在飞书开放平台完成三步(缺一不可):① 创建「企业自建应用」并启用机器人能力;② 事件与回调
        → 订阅方式选「使用长连接接收事件」,并添加事件 im.message.receive_v1;③
        开通权限:接收群聊中@机器人消息、读取用户发给机器人的单聊消息、发送消息(含单聊/群聊),然后创建版本并发布。
        保存后自动建立长连接,状态实时刷新;私聊直接发消息即可,群聊需 @ 机器人(一期仅支持文本)。
        连接失败的原因会显示在下方状态里,也可查看日志文件 logs/im.log(位于用户数据目录)。
      </div>

      <div className="im-list">
        {accounts === null && <div className="st-hint">加载中…</div>}
        {accounts !== null && accounts.length === 0 && (
          <div className="st-hint">
            暂无 IM 账号。创建飞书自建应用后,点「接入飞书机器人」填写 App ID / App Secret 即可。
          </div>
        )}
        {accounts?.map((a) => (
          <div key={a.id} className="mcp-item">
            <div className="mcp-item-main">
              <b>{a.name}</b>
              <span className="mcp-kind">飞书</span>
              {a.enabled ? (
                <span className="mcp-on">启用</span>
              ) : (
                <span className="mcp-off">停用</span>
              )}
              <span className="mcp-desc">
                状态:
                {a.status === 'connected'
                  ? '已连接'
                  : a.status === 'connecting'
                    ? '连接中…'
                    : a.status === 'error'
                      ? `连接失败:${a.statusText ?? ''}`
                      : '未启动'}
              </span>
            </div>
            <div className="mcp-item-ops">
              <button type="button" className="st-btn ghost sm" onClick={() => editAccount(a)}>
                编辑
              </button>
              <button type="button" className="st-btn ghost sm" onClick={() => void toggle(a)}>
                {a.enabled ? '停用' : '启用'}
              </button>
              <button
                type="button"
                className="st-btn ghost danger sm"
                onClick={() => void remove(a)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {open && (
        <div className="mcp-edit">
          <div className="st-title">
            {editId ? '编辑飞书账号(Secret 需重新填写)' : '接入飞书机器人'}
          </div>
          <label className="st-row">
            <span className="st-label">账号名称</span>
            <input
              className="st-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder="如:客服助手-飞书"
            />
          </label>
          <label className="st-row">
            <span className="st-label">App ID</span>
            <input
              className="st-input"
              value={form.appId}
              onChange={(e) => setForm((f) => ({ ...f, appId: e.target.value }))}
              placeholder="cli_xxxxxxxx"
            />
          </label>
          <label className="st-row">
            <span className="st-label">App Secret</span>
            <input
              type="password"
              className="st-input"
              value={form.appSecret}
              onChange={(e) => setForm((f) => ({ ...f, appSecret: e.target.value }))}
              placeholder="系统加密保存,不展示在界面上"
            />
          </label>
          <label className="st-row">
            <span className="st-label">保存后启用</span>
            <input
              type="checkbox"
              checked={form.enabled ?? false}
              onChange={(e) => setForm((f) => ({ ...f, enabled: e.target.checked }))}
            />
            <span className="st-hint-inline">启用即建立长连接开始接收消息</span>
          </label>
          <div className="st-actions">
            <button type="button" className="st-btn ghost" onClick={() => setOpen(false)}>
              取消
            </button>
            <button type="button" className="st-btn" disabled={saving} onClick={() => void save()}>
              {saving ? '保存中…' : '保存账号'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
