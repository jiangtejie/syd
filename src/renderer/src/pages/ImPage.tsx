import { useEffect, useState } from 'react'
import type { ImChannelAccount, ImChannelAccountInput, KeyAccountInfo } from '../../../shared/types'
import { SettingsCard, SwitchRow } from '../components/settings/ui'
import { toast } from '../stores/toast'
import './im.css'

/**
 * IM 渠道管理(一期:飞书机器人;嵌入 设置 → IM 渠道 tab)。
 * 机器人 = 本产品 AI 助手引擎通过飞书 WebSocket 长连接收发;
 * 私聊直接响应,群聊需 @;凭证 AppSecret 以系统加密存储。
 * 可选「绑定微信业务账号」:绑定后该渠道会话按绑定账号上下文运行,
 * 具备与客服工作台一致的业务查询能力(L1),否则仅通用对话。
 */

const imApi = window.api?.cs?.im
const keyStoreApi = window.api?.cs?.keyStore

export function ImSection(): React.JSX.Element {
  const [accounts, setAccounts] = useState<ImChannelAccount[] | null>(null)
  const [open, setOpen] = useState(false)
  const [wxAccounts, setWxAccounts] = useState<KeyAccountInfo[]>([])
  const [manualWx, setManualWx] = useState(false)
  const [form, setForm] = useState<ImChannelAccountInput>({
    name: '',
    channel: 'feishu',
    appId: '',
    appSecret: '',
    wxid: '',
    enabled: false
  })
  const [editId, setEditId] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)

  const load = async (): Promise<void> => {
    const res = await imApi?.list().catch(() => null)
    if (res?.ok && res.accounts) setAccounts(res.accounts as ImChannelAccount[])
    else setAccounts([])
  }

  /** 已导入密钥的微信账号(供绑定下拉;未就绪短暂重试) */
  const loadWxAccounts = async (): Promise<void> => {
    let list: KeyAccountInfo[] | null = null
    for (let i = 0; i < 5 && list === null; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1200))
      list = (await keyStoreApi?.list().catch(() => null)) ?? null
    }
    setWxAccounts(list ?? [])
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取 IM/微信账号(全仓同款模式)
    void load()
    void loadWxAccounts()
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
    setManualWx(false)
    setForm({
      name: '',
      channel: 'feishu',
      appId: '',
      appSecret: '',
      wxid: '',
      allowUsers: '',
      enabled: true
    })
    setOpen(true)
  }
  const editAccount = (a: ImChannelAccount): void => {
    setEditId(a.id)
    // 编辑时 Secret 可不重填(留空沿用原密钥);绑定账号/白名单回显
    const bound = a.wxid ?? ''
    setManualWx(!!bound && !wxAccounts.some((k) => k.wxid === bound))
    setForm({
      id: a.id,
      name: a.name,
      channel: 'feishu',
      appId: '',
      appSecret: '',
      wxid: bound,
      allowUsers: a.allowUsers ?? '',
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
    <div className="im-section">
      <div className="im-head">
        <div className="st-title">IM 渠道（飞书机器人）</div>
        <button type="button" className="st-btn" onClick={startNew}>
          ＋ 接入飞书机器人
        </button>
      </div>

      <SettingsCard title="接入说明" desc="三步接入飞书机器人,保存后自动建立长连接,状态实时刷新。">
        <p>
          ① 在飞书开放平台创建「企业自建应用」并启用机器人能力;② 事件与回调 →
          订阅方式选「使用长连接接收事件」, 并添加事件 im.message.receive_v1;③
          开通权限:接收群聊中@机器人消息、读取用户发给机器人的单聊消息、
          发送消息(含单聊/群聊),然后创建版本并发布。
        </p>
        <p>
          私聊直接发消息即可,群聊需 @ 机器人(一期仅支持文本)。连接失败的原因会显示在下方账号状态里,
          也可查看日志文件 logs/im.log(位于用户数据目录)。
        </p>
        <p>
          可选「绑定微信业务账号」:绑定后,机器人对话会以该账号的上下文运行,具备与客服工作台一致的业务查询能力
          (客户/群问题/监控/最近消息/统计等);不绑定则仅限通用对话,业务查询会被拒绝。
          绑定后默认任何能私聊或在群里 @
          该机器人的飞书用户都能触发业务查询——如需限定范围,请填写「业务查询白名单」。
        </p>
      </SettingsCard>

      <SettingsCard title="已接入账号(飞书)">
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
                  {a.wxid ? ` · 绑定业务:${a.wxid}` : ''}
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
      </SettingsCard>

      {open && (
        <div className="mcp-edit">
          <div className="st-title">{editId ? '编辑飞书账号' : '接入飞书机器人'}</div>
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
              placeholder={editId ? '留空表示沿用原密钥' : '系统加密保存,不展示在界面上'}
            />
          </label>
          <div className="st-row">
            <span className="st-label">绑定微信业务账号</span>
            {wxAccounts.length > 0 ? (
              <select
                className="st-input"
                value={manualWx ? '__manual__' : (form.wxid ?? '')}
                onChange={(e) => {
                  const v = e.target.value
                  const manual = v === '__manual__'
                  setManualWx(manual)
                  setForm((f) => ({ ...f, wxid: manual ? '' : v }))
                }}
              >
                <option value="">不绑定(仅通用对话)</option>
                {wxAccounts.map((k) => (
                  <option key={k.wxid} value={k.wxid}>
                    {k.wxid}
                    {k.source === 'manual' ? '(手动导入)' : ''}
                  </option>
                ))}
                <option value="__manual__">手动输入 wxid…</option>
              </select>
            ) : (
              <span className="st-hint-inline">
                暂无可用账号,请先在「微信数据」页导入密钥后再回来绑定
              </span>
            )}
          </div>
          {(wxAccounts.length === 0 || manualWx) && (
            <label className="st-row">
              <span className="st-label">业务账号 wxid</span>
              <input
                className="st-input"
                value={form.wxid ?? ''}
                onChange={(e) => setForm((f) => ({ ...f, wxid: e.target.value.trim() }))}
                placeholder="wxid_xxxxxxxx"
              />
            </label>
          )}
          <div className="st-hint-inline im-bind-hint">
            绑定后该渠道的 AI 对话将以该账号查询客户/群问题/消息等业务数据,与客服工作台同源
          </div>
          <div className="st-row st-row-top">
            <span className="st-label">业务查询白名单(可选)</span>
            <textarea
              className="st-input im-allow-area"
              rows={3}
              value={form.allowUsers ?? ''}
              onChange={(e) => setForm((f) => ({ ...f, allowUsers: e.target.value }))}
              placeholder="ou_xxxxxxxx,ou_yyyyyyyy(每行一个或逗号分隔)"
            />
          </div>
          <div className="st-hint-inline im-bind-hint">
            仅当已绑定微信业务账号时生效:留空 = 所有能 @
            机器人的人都能查询业务数据;填写后只有名单内的飞书用户可触发,其余消息被忽略。
            获取自己的标识:logs/im.log 里每条入站会记录 sender=ou_…;也可在飞书后台查看。
          </div>
          <SwitchRow
            label="保存后启用"
            desc="启用即建立长连接开始接收消息。"
            checked={form.enabled ?? false}
            onChange={(v) => setForm((f) => ({ ...f, enabled: v }))}
          />
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
