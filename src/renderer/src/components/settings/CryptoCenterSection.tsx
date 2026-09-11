import { useCallback, useEffect, useState } from 'react'
import { SettingsCard } from './ui'
import { useWorkbenchStore } from '../../stores/workbench'
import { toast } from '../../stores/toast'
import type { AccountReadiness, WarmupReport } from '../../../../shared/api'

/**
 * 解密一体化（体检 / 一键接入 / 预热）：
 * 把「密钥 → 库解密 → 图片密钥 → 语音/转写 → 缓存」这条链路的现状一处说清，
 * 并提供一个按钮把它跑通 —— 运营一台闲置机器时不用再逐项试。
 */

const STATUS_ICON: Record<string, string> = { ok: '✅', warn: '⚠️', fail: '❌', skip: '➖' }

function fmtMB(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${Math.round(bytes / 1024 / 1024)}MB`
    : `${Math.max(1, Math.round(bytes / 1024))}KB`
}

function CryptoCenterSection(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const cryptoApi = window.api?.cs?.crypto
  const [busy, setBusy] = useState<'onboard' | 'warmup' | 'check' | null>(null)
  const [readiness, setReadiness] = useState<AccountReadiness | null>(null)
  const [warmup, setWarmup] = useState<WarmupReport | null>(null)
  const [keyInput, setKeyInput] = useState('')
  /** 本机检测到的取 key 工具（本仓不分发，只帮用户找 + 一键试） */
  const [tools, setTools] = useState<Array<{
    id: string
    name: string
    path: string
    presetId: string | null
    note: string
  }> | null>(null)
  const [scanning, setScanning] = useState(false)
  const [toolLog, setToolLog] = useState<string[]>([])

  const check = useCallback(async (): Promise<void> => {
    if (!wxid) return
    const r = await cryptoApi?.readiness(wxid).catch(() => null)
    if (r?.ok && r.report) setReadiness(r.report)
  }, [cryptoApi, wxid])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 进入设置页时拉一次体检（全仓同款模式）
    void check()
  }, [check])

  const onboard = async (): Promise<void> => {
    setBusy('onboard')
    setWarmup(null)
    try {
      const r = await cryptoApi
        ?.onboard({ wxid: wxid || undefined, keyHex: keyInput.trim() || undefined })
        .catch(() => null)
      if (!r) return toast.error('一键接入失败（主进程无响应）')
      if (r.report)
        setReadiness({
          ...(readiness ?? ({} as AccountReadiness)),
          ...r.report,
          steps: r.report.steps
        } as AccountReadiness)
      if (r.ok) {
        toast.success(
          r.connected?.ok === false
            ? `接入完成，但连接失败：${r.connected.error ?? ''}`
            : '一键接入完成：密钥就绪、库已预热、监控已启动'
        )
        await check()
      } else {
        const failed = r.report?.steps.find((s) => s.status === 'fail')
        toast.error(failed ? `${failed.label}：${failed.detail}` : r.error || '一键接入未完成')
      }
    } finally {
      setBusy(null)
    }
  }

  /** 检测本机已有的取 key 工具 */
  const detectTools = async (): Promise<void> => {
    setScanning(true)
    setToolLog([])
    try {
      const r = await cryptoApi?.keyTools?.().catch(() => null)
      if (r?.ok) {
        setTools(r.tools ?? [])
        if ((r.tools ?? []).length === 0) {
          toast.error('没检测到取 key 工具（可把工具放到下载/桌面/文档，或设置 PATH）')
        }
      } else toast.error(r?.error || '检测失败')
    } finally {
      setScanning(false)
    }
  }

  /** 一键使用某个工具：按预设模板依次试，命中即校验落库 */
  // 名字不要以 use 开头：会被 ESLint 当成 React Hook
  const applyTool = async (tool: {
    name: string
    path: string
    presetId: string | null
  }): Promise<void> => {
    if (!wxid) return toast.error('请先在「微信数据与密钥」里选择账号')
    setBusy('onboard')
    setToolLog([])
    try {
      const r = await cryptoApi
        ?.keyToolRun?.({ wxid, command: tool.path, presetId: tool.presetId ?? undefined })
        .catch(() => null)
      const lines = (r?.attempts ?? []).map(
        (a) =>
          `${a.status === 'ok' ? '✅' : a.status === 'empty' ? '➖' : '⚠️'} ${tool.name} ${a.args.join(' ') || '(无参数)'}：${a.detail}`
      )
      setToolLog(lines)
      if (r?.ok) {
        toast.success(`${tool.name} 取到密钥并通过页 1 校验，已导入`)
        setKeyInput('')
        await check()
      } else toast.error(r?.error || '没取到可用密钥')
    } finally {
      setBusy(null)
    }
  }

  const doWarmup = async (): Promise<void> => {
    if (!wxid) return toast.error('请先在「微信数据与密钥」里选择账号')
    setBusy('warmup')
    try {
      const r = await cryptoApi?.warmup(wxid).catch(() => null)
      if (r?.report) {
        setWarmup(r.report)
        const okCount = r.report.items.filter((i) => i.ok).length
        toast.success(`预热完成 ${okCount}/${r.report.items.length} 个库`)
      } else toast.error(r?.error || '预热失败')
    } finally {
      setBusy(null)
    }
  }

  const steps = readiness?.steps ?? []
  const failed = steps.filter((s) => s.status === 'fail').length
  const warned = steps.filter((s) => s.status === 'warn').length

  return (
    <SettingsCard
      title="解密一体化"
      desc="一键接入：定位账号 → 取密钥 → 推导图片密钥 → 预热解密 → 连接并启动监控；也可随时体检与预热"
    >
      <div className="st-actions">
        <button
          type="button"
          className="st-btn"
          disabled={busy !== null}
          onClick={() => void onboard()}
        >
          {busy === 'onboard' ? '接入中…' : '一键接入'}
        </button>
        <button
          type="button"
          className="st-btn ghost"
          disabled={busy !== null || !wxid}
          onClick={() => void doWarmup()}
        >
          {busy === 'warmup' ? '预热中…' : '预热解密'}
        </button>
        <button
          type="button"
          className="st-btn ghost"
          disabled={busy !== null || !wxid}
          onClick={() => void check()}
        >
          体检
        </button>
        <span className="st-hint">
          {wxid
            ? failed > 0
              ? `${failed} 项未通过、${warned} 项待完善`
              : warned > 0
                ? `主链路可用，${warned} 项待完善`
                : '全部就绪'
            : '尚未选择账号'}
        </span>
      </div>

      <label className="st-row">
        <span className="st-label">密钥（可选，粘贴优先）</span>
        <input
          className="st-input"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="已有 64 位十六进制密钥时粘这里，一键接入会先校验再用；留空则自动获取"
        />
      </label>

      {/* 取 key 工具：本仓不分发工具，只负责「找到 + 一键试 + 校验落库」 */}
      <div className="st-actions">
        <button
          type="button"
          className="st-btn ghost"
          disabled={scanning || busy !== null}
          onClick={() => void detectTools()}
        >
          {scanning ? '检测中…' : '检测取 key 工具'}
        </button>
        <span className="st-hint">
          自动在本机 PATH / 下载 / 桌面 / 文档 / 程序目录里找 chatlog、PyWxDump、wx_key 等工具；
          本应用不分发这些工具，取到的候选**必须通过真实库页 1 校验**才会导入
        </span>
      </div>
      {tools && tools.length > 0 && (
        <div className="st-hint">
          {tools.map((t) => (
            <div key={t.id}>
              🔧 {t.name}：{t.path}
              <button
                type="button"
                className="st-btn ghost sm"
                disabled={busy !== null || !wxid}
                onClick={() => void applyTool(t)}
                style={{ marginLeft: 8 }}
              >
                一键使用
              </button>
            </div>
          ))}
        </div>
      )}
      {toolLog.length > 0 && (
        <div className="st-hint">
          {toolLog.map((line, i) => (
            <div key={i}>{line}</div>
          ))}
        </div>
      )}

      {steps.length > 0 && (
        <div className="st-hint">
          {steps.map((s) => (
            <div key={s.id}>
              {STATUS_ICON[s.status] ?? '•'} {s.label}：{s.detail}
            </div>
          ))}
        </div>
      )}

      {warmup && (
        <div className="st-hint">
          {warmup.items.map((i) => (
            <div key={i.name}>
              {i.ok ? '✅' : '❌'} {i.name}：{i.ok ? `${i.ms}ms` : i.error}
              {i.pages ? ` · ${i.pages} 页` : ''}
              {i.walMerged ? ' · 合并了 WAL' : ''}
            </div>
          ))}
        </div>
      )}

      {readiness && (
        <div className="st-hint">
          缓存：媒体 {readiness.cache.files} 个 · {fmtMB(readiness.cache.bytes)} · 归档{' '}
          {fmtMB(readiness.cache.archiveBytes)}（不清理） · 保留 {readiness.cache.policy.keepDays}{' '}
          天{readiness.voice.cachedWav > 0 ? ` · 语音已缓存 ${readiness.voice.cachedWav} 条` : ''}
        </div>
      )}
    </SettingsCard>
  )
}

export default CryptoCenterSection
