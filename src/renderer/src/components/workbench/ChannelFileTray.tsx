import { useCallback, useState } from 'react'
import { toast } from '../../stores/toast'
import { confirmAsk } from '../../stores/confirmDialog'
import { fmtTimeShort } from '../../../../shared/monitorMetrics'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

/**
 * 工作台侧栏「收到的渠道文件」:飞书等外部渠道接收并落盘的图片/文件,
 * 按渠道(账号)维度查看与清理,配合自动保留策略防止数据膨胀。
 */

interface FileItem {
  id: number
  channel: string
  accountId: number
  senderId?: string
  kind: string
  fileName: string
  bytes: number
  createdAt: number
}

interface FileAccount {
  id: number
  name: string
}

/** 线性描边图标：与左侧导航同一套 feather 风格，跟随 currentColor */
function TrayIcon(): React.JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3.5 6.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
      <path d="M8 13.5h8" />
    </svg>
  )
}

function FileKindIcon({ image }: { image: boolean }): React.JSX.Element {
  return (
    <svg
      width={14}
      height={14}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3.5" y="4" width="17" height="16" rx="2.5" />
      {image ? (
        <>
          <circle cx="9" cy="9.5" r="1.6" />
          <path d="m4.5 17.5 4.5-4.2 3 2.7 2.8-3.2 4.7 4.7" />
        </>
      ) : (
        <>
          <path d="M7.5 9h9" />
          <path d="M7.5 12.5h9" />
          <path d="M7.5 16h5.5" />
        </>
      )}
    </svg>
  )
}

const filesApi = window.api?.cs?.files
const configApi = window.api?.cs?.config
const CHANNEL_LABEL: Record<string, string> = { feishu: '飞书' }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function ChannelFileTray(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<FileItem[] | null>(null)
  const [totals, setTotals] = useState<{ count: number; bytes: number } | null>(null)
  const [accounts, setAccounts] = useState<FileAccount[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [autoClean, setAutoClean] = useState(true)
  const [keepDays, setKeepDays] = useState(30)
  const [maxMB, setMaxMB] = useState(50)
  /** 当前选中账号的保留覆盖(空=跟随全局;仅账号筛选时可见) */
  const [acctKeepDays, setAcctKeepDays] = useState('')
  /** 媒体侧现状（展示缓存 + 上报归档）：与渠道文件共用清理入口，策略独立 */
  const [media, setMedia] = useState<{
    keepDays: number
    files: number
    bytes: number
    archiveFiles: number
    archiveBytes: number
  } | null>(null)

  const load = useCallback(async (): Promise<void> => {
    const res = await filesApi
      ?.list({ accountId: accountId ?? undefined, limit: 600 })
      .catch(() => null)
    if (res?.ok) {
      setItems((res.files as FileItem[]) ?? [])
      setTotals(res.totals ?? null)
      if (res.accounts) setAccounts(res.accounts as FileAccount[])
    } else {
      setItems([])
    }
  }, [accountId])

  const loadPolicy = useCallback(async (): Promise<void> => {
    const p = await filesApi?.policy().catch(() => null)
    if (p?.ok) {
      if (typeof p.autoClean === 'boolean') setAutoClean(p.autoClean)
      if (typeof p.keepDays === 'number') setKeepDays(p.keepDays)
      if (typeof p.maxMB === 'number') setMaxMB(p.maxMB)
      if (p.media) {
        setMedia({
          keepDays: p.media.keepDays,
          files: p.media.files,
          bytes: p.media.bytes,
          archiveFiles: p.media.archiveFiles,
          archiveBytes: p.media.archiveBytes
        })
      }
    }
  }, [])

  /** 当前账号覆盖天数回显(空=跟随全局) */
  const loadAcctOverride = useCallback(async (): Promise<void> => {
    if (accountId === null) {
      setAcctKeepDays('')
      return
    }
    const cfg = await configApi?.getAll().catch(() => null)
    const v = cfg?.[`imFiles.keepDays.acct-${accountId}`]
    setAcctKeepDays(v && v !== '' ? String(v) : '')
  }, [accountId])

  useAsyncEffect(() => {
    void load()
    void loadPolicy()
  }, [load, loadPolicy])

  useAsyncEffect(loadAcctOverride, [loadAcctOverride])

  const openDialog = async (): Promise<void> => {
    setOpen(true)
    await load()
    await loadPolicy()
    await loadAcctOverride()
  }

  const removeOne = async (f: FileItem): Promise<void> => {
    const ok = await confirmAsk({
      title: '删除文件',
      message: `删除「${f.fileName}」?文件将从磁盘移除,不可恢复。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    const r = await filesApi?.remove([f.id]).catch(() => null)
    if (r?.ok) {
      toast.success('已删除')
      void load()
    } else {
      toast.error((r as { error?: string } | null)?.error || '删除失败')
    }
  }

  const clearFilter = async (): Promise<void> => {
    const list = items ?? []
    if (list.length === 0) return toast.error('当前筛选下没有文件')
    const label =
      accountId !== null ? `该账号的 ${list.length} 个文件` : `全部 ${list.length} 个文件`
    const ok = await confirmAsk({
      title: '批量删除文件',
      message: `删除${label}?文件将从磁盘移除,不可恢复。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    const r = await filesApi?.remove(list.map((f) => f.id)).catch(() => null)
    if (r?.ok) toast.success(`已删除 ${r.removed ?? list.length} 个文件`)
    else toast.error((r as { error?: string } | null)?.error || '删除失败')
    void load()
  }

  const pruneNow = async (): Promise<void> => {
    const r = await filesApi?.prune(true).catch(() => null)
    if (r?.ok) {
      toast.success(
        r.removed && r.removed > 0 ? `已清理 ${r.removed} 个过期/孤儿文件` : '没有需要清理的文件'
      )
      void load()
    } else {
      toast.error((r as { error?: string } | null)?.error || '清理失败')
    }
  }

  /** 移除当前账号的保留覆盖(回到全局策略) */
  const clearAcctOverride = async (): Promise<void> => {
    if (accountId === null) return
    await configApi?.set(`imFiles.keepDays.acct-${accountId}`, '')
    setAcctKeepDays('')
    toast.success('已清除该账号覆盖,跟随全局保留天数')
  }

  const savePolicy = async (): Promise<void> => {
    const d = Math.min(Math.max(Math.floor(keepDays) || 30, 1), 365)
    const mb = Math.min(Math.max(Math.floor(maxMB) || 0, 0), 500)
    setKeepDays(d)
    setMaxMB(mb)
    const sets: Array<Promise<unknown> | undefined> = [
      configApi?.set('imFiles.autoClean', autoClean ? '1' : '0'),
      configApi?.set('imFiles.keepDays', String(d)),
      configApi?.set('imFiles.maxBytes', String(mb))
    ]
    // 当前账号保留覆盖(空串=清除,跟随全局)
    if (accountId !== null) {
      const v = acctKeepDays.trim()
      const n = v === '' ? 0 : Math.floor(Number(v))
      const valid = v === '' || (Number.isFinite(n) && n >= 1 && n <= 365)
      if (valid) {
        sets.push(configApi?.set(`imFiles.keepDays.acct-${accountId}`, v === '' ? '' : String(n)))
      } else {
        return toast.error('账号覆盖天数需为 1-365(留空=跟随全局)')
      }
    }
    await Promise.all(sets)
    const parts = [
      autoClean ? `保留 ${d} 天自动清理` : '自动清理关闭',
      mb > 0 ? `单文件上限 ${mb}MB` : '不限制文件大小'
    ]
    if (accountId !== null && acctKeepDays.trim() !== '') {
      parts.push(`本账号保留 ${acctKeepDays.trim()} 天`)
    }
    toast.success(`已保存:${parts.join(';')}`)
  }

  const summary =
    totals && totals.count > 0 ? `${totals.count} 个 · ${fmtSize(totals.bytes)}` : null
  const accountName = (id: number): string =>
    accounts.find((a) => a.id === id)?.name ?? `账号#${id}`

  return (
    <div className="wb-filetray">
      <button type="button" className="wb-filetray-summary" onClick={() => void openDialog()}>
        <span className="wb-filetray-icon">
          <TrayIcon />
        </span>
        <span className="wb-filetray-text">
          <b>收到的渠道文件</b>
          <span>{summary ?? '暂无(飞书图片/文件会存档于此)'}</span>
        </span>
        <span className="wb-filetray-more">管理 ›</span>
      </button>

      {open && (
        <div className="confirm-mask" onClick={() => setOpen(false)}>
          <div className="confirm-dialog wb-files-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">渠道接收文件管理</div>
            <div className="wb-files-toolbar">
              <select
                className="ui-select wb-files-sel"
                value={accountId ?? '__all__'}
                onChange={(e) => {
                  const v = e.target.value
                  setAccountId(v === '__all__' ? null : Number(v))
                }}
              >
                <option value="__all__">全部渠道账号</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {CHANNEL_LABEL.feishu} · {a.name}
                  </option>
                ))}
              </select>
              <span className="wb-files-count">
                共 <b className="ui-num">{items?.length ?? 0}</b> 项 · 合计{' '}
                <b className="ui-num">{fmtSize(totals?.bytes ?? 0)}</b>
              </span>
              <span className="wb-files-spacer" />
              <button type="button" className="ui-btn is-ghost is-sm" onClick={() => void load()}>
                刷新
              </button>
              <button
                type="button"
                className="ui-btn is-danger is-sm"
                disabled={(items?.length ?? 0) === 0}
                onClick={() => void clearFilter()}
              >
                清空当前
              </button>
              <button
                type="button"
                className="ui-btn is-ghost is-sm"
                onClick={() => void pruneNow()}
              >
                清理过期/孤儿
              </button>
            </div>

            {/* 媒体缓存（图片/视频/表情解密产物 + 语音）：与渠道文件同一清理入口，策略独立 */}
            {media && (
              <div
                className="wb-files-media"
                title="清理按钮会一并回收；上报归档（archive/）属于你自己的数据，不参与淘汰"
              >
                媒体缓存 {media.files} 个 · {fmtSize(media.bytes)} · 保留 {media.keepDays} 天
                {media.archiveFiles > 0
                  ? ` · 上报归档 ${media.archiveFiles} 个 · ${fmtSize(media.archiveBytes)}（不清理）`
                  : ''}
              </div>
            )}

            <div className="wb-files-list">
              {items === null && <div className="wb-files-hint">加载中…</div>}
              {items !== null && items.length === 0 && (
                <div className="wb-files-hint">当前筛选下没有文件。</div>
              )}
              {items?.map((f) => (
                <div key={f.id} className="wb-file-item">
                  <span className="wb-file-kind">
                    <FileKindIcon image={f.kind === 'image'} />
                  </span>
                  <div className="wb-file-main">
                    <b title={f.fileName}>
                      {f.fileName || (f.kind === 'image' ? '未命名图片' : '未命名文件')}
                    </b>
                    <span>
                      {CHANNEL_LABEL[f.channel] ?? f.channel} · {accountName(f.accountId)} ·{' '}
                      {fmtTimeShort(f.createdAt)} · {fmtSize(f.bytes)}
                      {f.senderId ? ` · ${f.senderId}` : ''}
                    </span>
                  </div>
                  <div className="wb-file-ops">
                    <button
                      type="button"
                      className="ui-btn is-ghost is-sm"
                      title="在文件夹中显示"
                      onClick={() => void filesApi?.reveal(f.id)}
                    >
                      位置
                    </button>
                    <button
                      type="button"
                      className="ui-btn is-danger is-sm"
                      title="删除文件"
                      onClick={() => void removeOne(f)}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>

            <div className="wb-files-policy">
              <label className="wb-files-check">
                <input
                  type="checkbox"
                  checked={autoClean}
                  onChange={(e) => setAutoClean(e.target.checked)}
                />
                自动清理
              </label>
              <span>全局保留</span>
              <input
                className="ui-input wb-files-num"
                type="number"
                min={1}
                max={365}
                value={keepDays}
                onChange={(e) => setKeepDays(Number(e.target.value))}
              />
              <span>天</span>
              <span>单文件上限</span>
              <input
                className="ui-input wb-files-num"
                type="number"
                min={0}
                max={500}
                value={maxMB}
                onChange={(e) => setMaxMB(Number(e.target.value))}
              />
              <span>MB(0=不限,超限拒收并回执)</span>
              {accountId !== null && (
                <>
                  <span>本账号保留覆盖</span>
                  <input
                    className="ui-input wb-files-num"
                    type="number"
                    min={1}
                    max={365}
                    placeholder="空=全局"
                    value={acctKeepDays}
                    onChange={(e) => setAcctKeepDays(e.target.value)}
                  />
                  <span>天</span>
                  {acctKeepDays.trim() !== '' && (
                    <button
                      type="button"
                      className="ui-btn is-ghost is-sm"
                      onClick={() => void clearAcctOverride()}
                    >
                      清除覆盖
                    </button>
                  )}
                </>
              )}
              <button
                type="button"
                className="ui-btn is-primary is-sm"
                onClick={() => void savePolicy()}
              >
                保存策略
              </button>
            </div>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn" onClick={() => setOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
