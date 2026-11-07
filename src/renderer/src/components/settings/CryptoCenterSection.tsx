import { useCallback, useState } from 'react'
import { SettingsCard, StatusPill } from './ui'
import { useWorkbenchStore } from '../../stores/workbench'
import { toast } from '../../stores/toast'
import type { AccountReadiness, WarmupReport } from '../../../../shared/api'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

/**
 * 解密一体化（体检 / 一键接入 / 预热）：
 * 把「密钥 → 库解密 → 图片密钥 → 语音/转写 → 缓存」这条链路的现状一处说清，
 * 并提供一个按钮把它跑通 —— 运营一台闲置机器时不用再逐项试。
 */

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

  const check = useCallback(async (): Promise<void> => {
    if (!wxid) return
    const r = await cryptoApi?.readiness(wxid).catch(() => null)
    if (r?.ok && r.report) setReadiness(r.report)
  }, [cryptoApi, wxid])

  useAsyncEffect(check, [check])

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
  const okCount = steps.filter((s) => s.status === 'ok').length

  return (
    <SettingsCard
      title="解密一体化"
      desc="一键接入：定位账号 → 校验并导入你粘贴的密钥 → 推导图片密钥 → 预热解密 → 连接并启动监控；也可随时体检与预热"
      extra={
        <StatusPill
          tone={!wxid ? 'off' : failed > 0 ? 'bad' : warned > 0 ? 'warn' : 'ok'}
          text={
            !wxid
              ? '未选择账号'
              : failed > 0
                ? `${failed} 项未通过`
                : warned > 0
                  ? `${warned} 项待完善`
                  : '全部就绪'
          }
        />
      }
    >
      <div className="st-actions">
        <button
          type="button"
          className="ui-btn is-primary"
          disabled={busy !== null}
          onClick={() => void onboard()}
        >
          {busy === 'onboard' ? '接入中…' : '一键接入'}
        </button>
        <button
          type="button"
          className="ui-btn"
          disabled={busy !== null || !wxid}
          onClick={() => void doWarmup()}
        >
          {busy === 'warmup' ? '预热中…' : '预热解密'}
        </button>
        <button
          type="button"
          className="ui-btn"
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
        <span className="st-label">密钥（64 位十六进制）</span>
        <input
          className="st-input"
          value={keyInput}
          onChange={(e) => setKeyInput(e.target.value)}
          placeholder="从任何你信任的工具导出后粘这里；一键接入会先用真实库做页 1 校验，通过才落库"
        />
      </label>

      {steps.length > 0 && (
        <div className="st-probe">
          <div className="st-probe-head">
            <span>体检结果</span>
            <span className="ui-num">
              {okCount}/{steps.length}
            </span>
          </div>
          {steps.map((s) => (
            <div key={s.id} className={`st-probe-row is-${s.status}`}>
              <span className="st-probe-icon" aria-hidden="true">
                {s.status === 'ok'
                  ? '✓'
                  : s.status === 'fail'
                    ? '✗'
                    : s.status === 'warn'
                      ? '!'
                      : '–'}
              </span>
              <span className="st-probe-label">{s.label}</span>
              <span className="st-probe-detail">{s.detail}</span>
            </div>
          ))}
        </div>
      )}

      {warmup && (
        <div className="st-probe">
          <div className="st-probe-head">
            <span>预热结果</span>
            <span className="ui-num">
              {warmup.items.filter((i) => i.ok).length}/{warmup.items.length}
            </span>
          </div>
          {warmup.items.map((i) => (
            <div key={i.name} className={`st-probe-row ${i.ok ? 'is-ok' : 'is-fail'}`}>
              <span className="st-probe-icon" aria-hidden="true">
                {i.ok ? '✓' : '✗'}
              </span>
              <span className="st-probe-label">{i.name}</span>
              <span className="st-probe-detail">
                {i.ok
                  ? [`${i.ms}ms`, i.pages ? `${i.pages} 页` : '', i.walMerged ? '合并了 WAL' : '']
                      .filter(Boolean)
                      .join(' · ')
                  : i.error}
              </span>
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
