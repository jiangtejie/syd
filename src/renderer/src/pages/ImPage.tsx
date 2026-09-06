import { useEffect, useRef, useState } from 'react'
import type { ImChannelAccount, ImChannelAccountInput, KeyAccountInfo } from '../../../shared/types'
import { SettingsCard, SwitchRow } from '../components/settings/ui'
import { toast } from '../stores/toast'
import { confirmAsk } from '../stores/confirmDialog'
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

const CHAN_LABEL: Record<string, string> = { feishu: '飞书机器人', wechat_claw: '微信 ClawBot' }

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
  // ── ClawBot 扫码绑定状态(二维码由主进程获取,token 不进渲染层) ──
  const [scanBox, setScanBox] = useState<{ key: string; qrImg?: string; qrUrl?: string } | null>(
    null
  )
  const [scanFetching, setScanFetching] = useState(false)
  const [scanErr, setScanErr] = useState(false)
  const [scanMsg, setScanMsg] = useState('')
  const scanTimer = useRef<ReturnType<typeof setInterval> | null>(null)

  const stopScanPoll = (): void => {
    if (scanTimer.current) {
      clearInterval(scanTimer.current)
      scanTimer.current = null
    }
  }
  useEffect(
    () => () => {
      stopScanPoll()
    },
    []
  )
  const closeScan = (): void => {
    stopScanPoll()
    setScanBox(null)
    setScanErr(false)
  }
  const startScan = async (): Promise<void> => {
    stopScanPoll()
    setScanBox(null)
    setScanErr(false)
    setScanFetching(true)
    setScanMsg('正在获取授权二维码…')
    const res = await imApi
      ?.clawQrStart({
        name: form.name?.trim() || '微信 ClawBot',
        baseUrl: form.baseUrl?.trim() || undefined,
        wxid: form.wxid?.trim() || undefined,
        allowUsers: form.allowUsers?.trim() || undefined
      })
      .catch(() => null)
    if (!res?.ok || !res.key) {
      setScanFetching(false)
      setScanErr(true)
      setScanMsg((res as { error?: string } | null)?.error || '获取二维码失败,请检查网络后重试')
      return
    }
    setScanFetching(false)
    setScanBox({ key: res.key, qrImg: res.qrImg, qrUrl: res.qrUrl })
    setScanMsg('请用微信扫码授权 ClawBot;确认后自动创建并启用账号(二维码约 3 分钟有效)')
    let ticks = 0 // 1.2s/次;~150s 判定超时,与服务端二维码有效期一致
    const inFlight = { v: false }
    scanTimer.current = setInterval(() => {
      if (inFlight.v) return
      if (++ticks > 124) {
        stopScanPoll()
        setScanErr(true)
        setScanMsg('扫码超时,二维码已失效,请重新获取')
        return
      }
      inFlight.v = true
      void imApi
        ?.clawQrPoll(res.key as string)
        .then((poll) => {
          if (!poll) return // 瞬时网络失败:下一轮自动重试
          if (poll.status === 'confirmed') {
            stopScanPoll()
            setScanMsg('授权成功,账号已自动创建并启用')
            toast.success('ClawBot 账号已创建并启用')
            setScanBox(null)
            setOpen(false)
            void load()
          } else if (poll.status === 'expired') {
            stopScanPoll()
            setScanErr(true)
            setScanMsg('二维码已过期或被取消,请重新获取')
          } else if (poll.status === 'error') {
            stopScanPoll()
            setScanErr(true)
            setScanMsg(poll.error || '授权确认失败,请重新获取')
          } else if (poll.status === 'scanned') {
            setScanMsg('已扫码,请在手机上点击确认绑定…')
          } else {
            setScanMsg(ticks > 50 ? '请尽快完成扫码,二维码即将过期…' : '等待扫码中…')
          }
        })
        .catch(() => undefined)
        .finally(() => {
          inFlight.v = false
        })
    }, 1200)
  }

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
    void load()
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取可用微信账号供绑定下拉(全仓同款模式)
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
      clawToken: '',
      baseUrl: '',
      wxid: '',
      allowUsers: '',
      enabled: true
    })
    setOpen(true)
  }
  const editAccount = (a: ImChannelAccount): void => {
    setEditId(a.id)
    // 编辑时密钥可不重填(留空沿用原密文);绑定账号/白名单回显
    const bound = a.wxid ?? ''
    setManualWx(!!bound && !wxAccounts.some((k) => k.wxid === bound))
    setForm({
      id: a.id,
      name: a.name,
      channel: a.channel,
      appId: '',
      appSecret: '',
      clawToken: '',
      baseUrl: '',
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
    const ok = await confirmAsk({
      title: '删除 IM 账号',
      message: `删除 IM 账号「${a.name}」?其会话映射与接收文件索引将一并删除。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
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
        <div className="st-title">IM 渠道（飞书机器人 / 微信 ClawBot）</div>
        <button type="button" className="st-btn" onClick={startNew}>
          ＋ 接入 IM 账号
        </button>
      </div>

      <SettingsCard
        title="接入说明"
        desc="两种官方渠道:飞书机器人(自建应用长连接)与微信 ClawBot(腾讯官方 iLink 智能体机器人,需在微信内开通 ClawBot 并获取 bot_token)。保存后自动连接,状态实时刷新。"
      >
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
        <p>
          微信 ClawBot:在微信内开通官方「ClawBot(智能体)」后可二选一接入:直接粘贴 bot_token,
          或点「扫码绑定」用微信扫授权二维码自动建号(免去手动获取 token)。 机器人经腾讯 iLink
          官方通道收发文字消息,媒体(图片/文件)仅提示不解析,回复需本应用保持运行。
        </p>
      </SettingsCard>

      <SettingsCard title="已接入账号(IM 渠道)">
        <div className="im-list">
          {accounts === null && <div className="st-hint">加载中…</div>}
          {accounts !== null && accounts.length === 0 && (
            <div className="st-hint">
              暂无 IM 账号。点「接入 IM 账号」选择 飞书机器人 或 微信 ClawBot,按界面提示填写即可。
            </div>
          )}
          {accounts?.map((a) => (
            <div key={a.id} className="mcp-item">
              <div className="mcp-item-main">
                <b>{a.name}</b>
                <span className="mcp-kind">{CHAN_LABEL[a.channel] ?? a.channel}</span>
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
          <div className="st-title">
            {editId ? '编辑账号' : '接入新账号'}
            {form.channel ? ` · ${CHAN_LABEL[form.channel]}` : ''}
          </div>
          {!editId && (
            <div className="im-kind-pick">
              {(['feishu', 'wechat_claw'] as const).map((k) => (
                <button
                  key={k}
                  type="button"
                  className={`im-kind-btn${form.channel === k ? ' is-on' : ''}`}
                  onClick={() => {
                    if (form.channel === k) return
                    setForm((f) => ({
                      ...f,
                      channel: k,
                      appId: '',
                      appSecret: '',
                      clawToken: '',
                      baseUrl: ''
                    }))
                  }}
                >
                  {CHAN_LABEL[k]}
                </button>
              ))}
            </div>
          )}
          <label className="st-row">
            <span className="st-label">账号名称</span>
            <input
              className="st-input"
              value={form.name}
              onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
              placeholder={`如:客服助手-${form.channel === 'feishu' ? '飞书' : 'ClawBot'}`}
            />
          </label>
          {form.channel === 'feishu' ? (
            <>
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
            </>
          ) : (
            <>
              <label className="st-row">
                <span className="st-label">bot_token</span>
                <input
                  type="password"
                  className="st-input"
                  value={form.clawToken ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, clawToken: e.target.value }))}
                  placeholder={
                    editId ? '留空表示沿用原 token' : '微信 ClawBot 登录后获取的 bot_token'
                  }
                />
              </label>
              <label className="st-row">
                <span className="st-label">网关 Base URL(可选)</span>
                <input
                  className="st-input"
                  value={form.baseUrl ?? ''}
                  onChange={(e) => setForm((f) => ({ ...f, baseUrl: e.target.value }))}
                  placeholder="默认 https://ilinkai.weixin.qq.com"
                />
              </label>
              {!editId && (
                <>
                  <div className="st-row im-scan-row">
                    <span className="st-label" />
                    <div className="im-scan-cell">
                      <button
                        type="button"
                        className="st-btn ghost sm"
                        disabled={scanFetching}
                        onClick={() => void startScan()}
                      >
                        {scanFetching ? '获取二维码中…' : '扫码绑定(免填 token)'}
                      </button>
                      <span className="st-hint-inline">
                        点此弹出二维码,用微信扫码授权 ClawBot 后自动创建并启用账号
                      </span>
                    </div>
                  </div>
                  {!scanBox && scanErr && (
                    <div className="st-row">
                      <span className="st-label" />
                      <span className="st-hint-inline im-scan-err">{scanMsg}</span>
                    </div>
                  )}
                </>
              )}
            </>
          )}
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

      {scanBox && (
        <div className="im-qr-mask" onClick={closeScan}>
          <div className="im-qr-box" onClick={(e) => e.stopPropagation()}>
            <div className="st-title">扫码绑定微信 ClawBot</div>
            <div className={`im-qr-msg${scanErr ? ' is-err' : ''}`}>{scanMsg}</div>
            <div className="im-qr-stage">
              {scanBox.qrImg ? (
                <img className="im-qr-img" src={scanBox.qrImg} alt="ClawBot 授权二维码" />
              ) : (
                <div className="st-hint">
                  二维码图片加载失败
                  {scanBox.qrUrl && (
                    <>
                      ,可在浏览器打开:
                      <a href={scanBox.qrUrl} target="_blank" rel="noreferrer">
                        授权链接
                      </a>
                    </>
                  )}
                </div>
              )}
            </div>
            <ol className="im-qr-steps">
              <li>打开手机微信,搜索并进入官方「ClawBot(智能体)」</li>
              <li>在 ClawBot 内选择扫码绑定/登录入口,用微信扫一扫上方二维码</li>
              <li>按页面提示确认授权;成功后本窗口自动创建账号并开始连接</li>
            </ol>
            <div className="st-actions">
              {scanErr ? (
                <>
                  <button type="button" className="st-btn ghost" onClick={closeScan}>
                    取消
                  </button>
                  <button
                    type="button"
                    className="st-btn"
                    disabled={scanFetching}
                    onClick={() => void startScan()}
                  >
                    重新获取二维码
                  </button>
                </>
              ) : (
                <button type="button" className="st-btn ghost" onClick={closeScan}>
                  取消
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
