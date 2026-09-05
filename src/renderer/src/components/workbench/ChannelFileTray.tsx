import { useCallback, useEffect, useState } from 'react'
import { toast } from '../../stores/toast'

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

const filesApi = window.api?.cs?.files
const configApi = window.api?.cs?.config
const CHANNEL_LABEL: Record<string, string> = { feishu: '飞书' }

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function fmtTime(ts: number): string {
  const d = new Date(ts)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

export function ChannelFileTray(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<FileItem[] | null>(null)
  const [totals, setTotals] = useState<{ count: number; bytes: number } | null>(null)
  const [accounts, setAccounts] = useState<FileAccount[]>([])
  const [accountId, setAccountId] = useState<number | null>(null)
  const [autoClean, setAutoClean] = useState(true)
  const [keepDays, setKeepDays] = useState(30)

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
    }
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载拉取文件摘要与清理策略(全仓同款模式)
    void load()
    void loadPolicy()
  }, [load, loadPolicy])

  const openDialog = async (): Promise<void> => {
    setOpen(true)
    await load()
    await loadPolicy()
  }

  const removeOne = async (f: FileItem): Promise<void> => {
    if (!window.confirm(`删除「${f.fileName}」?文件将从磁盘移除,不可恢复。`)) return
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
    if (!window.confirm(`删除${label}?文件将从磁盘移除,不可恢复。`)) return
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

  const savePolicy = async (): Promise<void> => {
    const d = Math.min(Math.max(Math.floor(keepDays) || 30, 1), 365)
    setKeepDays(d)
    await Promise.all([
      configApi?.set('imFiles.autoClean', autoClean ? '1' : '0'),
      configApi?.set('imFiles.keepDays', String(d))
    ])
    toast.success(autoClean ? `已保存:保留 ${d} 天后自动清理` : '已保存:自动清理关闭')
  }

  const summary =
    totals && totals.count > 0 ? `${totals.count} 个 · ${fmtSize(totals.bytes)}` : null
  const accountName = (id: number): string =>
    accounts.find((a) => a.id === id)?.name ?? `账号#${id}`

  return (
    <div className="wb-filetray">
      <button type="button" className="wb-filetray-summary" onClick={() => void openDialog()}>
        <span className="wb-filetray-icon">📁</span>
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
                className="st-input wb-files-sel"
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
                {items?.length ?? 0} 项 · 合计 {fmtSize(totals?.bytes ?? 0)}
              </span>
              <span className="wb-files-spacer" />
              <button type="button" className="st-btn ghost sm" onClick={() => void load()}>
                刷新
              </button>
              <button
                type="button"
                className="st-btn ghost sm"
                disabled={(items?.length ?? 0) === 0}
                onClick={() => void clearFilter()}
              >
                清空当前
              </button>
              <button type="button" className="st-btn ghost sm" onClick={() => void pruneNow()}>
                清理过期/孤儿
              </button>
            </div>

            <div className="wb-files-list">
              {items === null && <div className="st-hint">加载中…</div>}
              {items !== null && items.length === 0 && (
                <div className="st-hint">当前筛选下没有文件。</div>
              )}
              {items?.map((f) => (
                <div key={f.id} className="wb-file-item">
                  <span className="wb-file-kind">{f.kind === 'image' ? '🖼' : '📄'}</span>
                  <div className="wb-file-main">
                    <b title={f.fileName}>
                      {f.fileName || (f.kind === 'image' ? '未命名图片' : '未命名文件')}
                    </b>
                    <span>
                      {CHANNEL_LABEL[f.channel] ?? f.channel} · {accountName(f.accountId)} ·{' '}
                      {fmtTime(f.createdAt)} · {fmtSize(f.bytes)}
                      {f.senderId ? ` · ${f.senderId}` : ''}
                    </span>
                  </div>
                  <div className="wb-file-ops">
                    <button
                      type="button"
                      className="st-btn ghost sm"
                      title="在文件夹中显示"
                      onClick={() => void filesApi?.reveal(f.id)}
                    >
                      位置
                    </button>
                    <button
                      type="button"
                      className="st-btn ghost danger sm"
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
              <label className="lg-auto">
                <input
                  type="checkbox"
                  checked={autoClean}
                  onChange={(e) => setAutoClean(e.target.checked)}
                />
                自动清理
              </label>
              <span>保留</span>
              <input
                className="st-input wb-files-num"
                type="number"
                min={1}
                max={365}
                value={keepDays}
                onChange={(e) => setKeepDays(Number(e.target.value))}
              />
              <span>天(启动与每 6 小时清理一次;手动删除与「清空当前」立即生效)</span>
              <button type="button" className="st-btn sm" onClick={() => void savePolicy()}>
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
