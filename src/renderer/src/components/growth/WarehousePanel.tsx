import { fmt, fmtNum, ORIGIN_LABEL, USAGE_LABEL } from './meta'
import { memo, useCallback, useEffect, useRef, useState } from 'react'
import { toast } from '../../stores/toast'
import { confirmAsk } from '../../stores/confirmDialog'
import SkeletonRows from './SkeletonRows'
import { growthApi } from './meta'
import { Badge, SearchInput, EmptyState, ErrBar } from './common'
import { MediaGallery } from './MediaGallery'
import DecompCard from './DecompCard'
import { remoteImageUrlsOf, remoteVideoUrlOf } from './meta'
import type { GrowthContentDetailView, GrowthContentItem } from '../../../../shared/growth'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

const KIND_LABEL: Record<string, string> = {
  image_text: '图文',
  video: '视频',
  unknown: '未知'
}

/** 详情里的两个短枚举（与 USAGE_LABEL / 状态文案同源，别处再写第二份） */
const USAGE_OPTIONS: ReadonlyArray<{ value: string; label: string; hint: string }> = [
  { value: 'ref', label: '内部参考', hint: '只用于学习分析，对外发布前必须原创化' },
  { value: 'own', label: '自有素材', hint: '本店实拍，可直接使用' },
  { value: 'licensed', label: '已授权', hint: '已获得授权，可用于对外发布' }
]
const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'new', label: '新入库' },
  { value: 'ready', label: '可爆改' },
  { value: 'used', label: '已爆改/已用' },
  { value: 'archived', label: '已归档' }
]

export interface WarehousePanelProps {
  onChanged: () => void
  /** 「用 AI 爆改」：交回页面去「找到或创建该素材的 AI 任务 + 切到 AI 工作台」 */
  onOpenWorkbench?: (contentId: number) => void
}

/**
 * 链接入库条:输入草稿内聚在自身 state。
 * 若放在 WarehousePanel 顶层,每敲一个字符都会重渲染下面 100 行素材表。
 */
export const IngestBar = memo(function IngestBar({
  busy,
  inputRef,
  onSubmit
}: {
  busy: boolean
  inputRef: React.RefObject<HTMLInputElement | null>
  onSubmit: (text: string) => Promise<boolean>
}): React.JSX.Element {
  const [value, setValue] = useState('')
  const submit = (): void => {
    const v = value.trim()
    if (!v || busy) return
    void onSubmit(v).then((ok) => {
      if (ok) setValue('') // 失败保留原文,便于修正后重试
    })
  }
  return (
    <>
      <input
        ref={inputRef}
        className={'ui-input gth-input'}
        value={value}
        placeholder={'粘贴小红书/抖音分享链接或口令, Enter 入库(自动识别平台与 ID · 去重防重复)'}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit()
        }}
      />
      <button
        className={'ui-btn is-primary gth-btn'}
        type={'button'}
        disabled={busy || !value.trim()}
        onClick={submit}
      >
        {busy ? '解析中…' : '链接入库'}
      </button>
    </>
  )
})

export function WarehousePanel({
  onChanged,
  onOpenWorkbench
}: WarehousePanelProps): React.JSX.Element {
  const PAGE_SIZE = 100
  const [items, setItems] = useState<GrowthContentItem[]>([])
  const [total, setTotal] = useState(0)
  const [loading, setLoading] = useState(true)
  const [loadingMore, setLoadingMore] = useState(false)
  const [loadErr, setLoadErr] = useState('')
  const [keyword, setKeyword] = useState('')
  const [origin, setOrigin] = useState('')
  const [usage, setUsage] = useState('')
  const [status, setStatus] = useState('')
  const [noDecomp, setNoDecomp] = useState(false)
  const [sort, setSort] = useState<'created' | 'score' | 'likes'>('created')
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busyIngest, setBusyIngest] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [batchBusy, setBatchBusy] = useState(false)
  const [detailId, setDetailId] = useState<number | null>(null)
  const [detail, setDetail] = useState<GrowthContentDetailView | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [patchBusy, setPatchBusy] = useState(false)
  const [noteDraft, setNoteDraft] = useState('')
  /** 正文展开态：默认截断（长正文会把整个详情卡撑得很长，挡住下面的拆解卡） */
  const [textOpen, setTextOpen] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState<number | null>(null)
  const reqRef = useRef(0)
  /** 已加载列表的同步镜像: 供分页游标使用, 避免把 items.length 放进 load 依赖导致重置循环 */
  const itemsRef = useRef<GrowthContentItem[]>([])
  const ingestRef = useRef<HTMLInputElement | null>(null)
  const detailRef = useRef<HTMLDivElement | null>(null)

  /** 拉取素材: reset=true 覆盖(筛选/排序/首载), false 追加下一页 */
  const load = useCallback(
    async (reset = false): Promise<void> => {
      if (!growthApi) return
      const seq = ++reqRef.current
      if (reset) setLoading(true)
      else setLoadingMore(true)
      setLoadErr('')
      try {
        const offset = reset ? 0 : itemsRef.current.length
        const filter: Record<string, unknown> = { limit: PAGE_SIZE, offset }
        const k = keyword.trim()
        if (k) filter.keyword = k
        if (origin) filter.origin = origin
        if (usage) filter.usage = usage
        if (status) filter.status = status
        if (noDecomp) filter.noDecomp = true
        if (sort !== 'created') filter.sort = sort
        const res = await growthApi.listContent(filter as never)
        if (seq !== reqRef.current) return
        if (!res.ok) {
          setLoadErr(res.error || '读取素材失败')
          return
        }
        const page = res.items ?? []
        const next = reset ? page : itemsRef.current.concat(page)
        itemsRef.current = next
        setItems(next)
        setTotal(res.total ?? page.length)
      } catch (e) {
        if (seq === reqRef.current) setLoadErr(e instanceof Error ? e.message : '读取素材失败')
      } finally {
        if (seq === reqRef.current) {
          setLoading(false)
          setLoadingMore(false)
        }
      }
    },
    [keyword, origin, usage, status, noDecomp, sort]
  )

  useAsyncEffect(() => {
    void load(true)
  }, [load])

  /**
   * 详情面板跟着列表走：详情那条已经不在当前列表里（被删掉、或改了筛选/排序后不属于这个视野）就收起来。
   * 只在「没有更多分页且不在加载」时判断 —— 否则翻页途中会误判成"不在列表里"而把详情关掉。
   */
  useEffect(() => {
    if (detailId == null || loading || loadingMore) return
    if (items.length < total) return
    if (items.some((i) => i.id === detailId)) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 列表刷新后同步关闭已失效的详情(全仓同款模式)
    setDetailId(null)
    setDetail(null)
  }, [items, total, loading, loadingMore, detailId])

  /** 强制重拉详情: 不走 openDetail 的「同一行再点收起」逻辑 */
  const refreshDetail = async (id: number): Promise<void> => {
    if (!growthApi) return
    try {
      const res = await growthApi.getContent(id)
      if (res.ok && res.item) {
        const item = res.item as GrowthContentDetailView
        setDetail({ ...item, remixOutputs: item.remixOutputs ?? [] })
        setNoteDraft(item.note ?? '')
      }
    } catch {
      /* 详情刷新失败不影响列表主流程 */
    }
  }

  /** 复制正文（与素材列表的复制同一条 IPC 通道，不要在渲染端直接碰 navigator.clipboard） */
  const copyTextRow = async (text: string): Promise<void> => {
    if (!text.trim()) return
    const res = await growthApi?.copyClipboard?.({ text })
    if (res?.ok) toast.success('正文已复制')
    else toast.error(res?.error || '复制失败')
  }

  const hasMore = items.length < total

  const openDetail = async (id: number): Promise<void> => {
    if (!growthApi) return
    if (detailId === id) {
      setDetailId(null)
      setDetail(null)
      return
    }
    setDetailId(id)
    setDetail(null)
    setTextOpen(false)
    setDetailLoading(true)
    try {
      const res = await growthApi.getContent(id)
      if (!res.ok) {
        toast.error(res.error || '读取详情失败')
        return
      }
      if (res.item) {
        // 防御: 兼容旧主进程返回(可能缺 remixOutputs 字段)
        const item = res.item as GrowthContentDetailView
        setDetail({ ...item, remixOutputs: item.remixOutputs ?? [] })
        setNoteDraft(item.note ?? '')
      }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '读取详情失败')
    } finally {
      setDetailLoading(false)
      // 详情在列表下方: 打开后滚动定位, 避免用户找不到
      setTimeout(
        () => detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
        80
      )
    }
  }

  const toggleSelect = (id: number): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = items.length > 0 && items.every((it) => selected.has(it.id))

  const toggleAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(items.map((it) => it.id)))
  }

  const batchApply = async (patch: { usage?: string; status?: string }): Promise<void> => {
    if (!growthApi || selected.size === 0) return
    setBatchBusy(true)
    try {
      const res = await growthApi.batchPatch(Array.from(selected), patch)
      if (!res.ok) {
        toast.error(res.error || '批量更新失败')
        return
      }
      toast.success('已更新 ' + String(res.updated ?? 0) + ' 条')
      setSelected(new Set())
      void load(true)
    } finally {
      setBatchBusy(false)
    }
  }

  /** 批量导出发布包：只弹一次目录，每条素材在父目录下各建一个「标题-id」子目录 */
  const batchExport = async (): Promise<void> => {
    if (!growthApi?.exportPackageBatch || selected.size === 0) return
    setBatchBusy(true)
    try {
      const res = await growthApi.exportPackageBatch(Array.from(selected))
      // 用户取消目录选择不算失败，别弹红字
      if (!res.ok) {
        if (res.error !== '已取消导出') toast.error(res.error || '导出失败')
        return
      }
      const parts = [
        '已导出 ' + String(res.exported ?? 0) + ' 条(' + String(res.files ?? 0) + ' 个文件)'
      ]
      const failedCount = (res.failed ?? []).length
      if (failedCount > 0) parts.push(String(failedCount) + ' 条失败')
      toast.success(parts.join(' · '))
      if (res.dir) window.api?.cs?.export?.openFolder?.(res.dir)
    } finally {
      setBatchBusy(false)
    }
  }

  const batchRemove = async (): Promise<void> => {
    if (!growthApi || selected.size === 0) return
    const okDel = await confirmAsk({
      title: '批量删除素材',
      message: '将删除选中的 ' + String(selected.size) + ' 条素材记录(本地图片文件保留)。',
      confirmText: '删除',
      danger: true
    })
    if (!okDel) return
    setBatchBusy(true)
    try {
      const res = await growthApi.batchRemove(Array.from(selected))
      if (!res.ok) {
        toast.error(res.error || '批量删除失败')
        return
      }
      toast.success('已删除 ' + String(res.removed ?? 0) + ' 条')
      setSelected(new Set())
      itemsRef.current = []
      if (detailId && selected.has(detailId)) {
        setDetailId(null)
        setDetail(null)
      }
      void load(true)
      onChanged()
    } finally {
      setBatchBusy(false)
    }
  }

  const uploadLocal = async (): Promise<void> => {
    if (!growthApi) return
    setUploading(true)
    try {
      const res = await growthApi.uploadLocal()
      if (!res.ok) {
        if (res.error !== '已取消选择') toast.error(res.error || '导入失败')
        return
      }
      toast.success(
        '已导入 ' +
          String(res.added ?? 0) +
          ' 个文件' +
          (res.skipped && res.skipped.length > 0
            ? '(跳过 ' + String(res.skipped.length) + ' 个)'
            : '')
      )
      void load(true)
      onChanged()
    } finally {
      setUploading(false)
    }
  }

  const redownload = async (id: number): Promise<void> => {
    if (!growthApi) return
    setPatchBusy(true)
    try {
      const res = await growthApi.redownloadMedia(id)
      if (!res.ok) {
        toast.error(res.error || '重新下载失败')
        return
      }
      toast.success(
        '已重新下载 ' +
          String(res.added ?? 0) +
          ' 张' +
          ((res.failed ?? 0) > 0 ? ', 失败 ' + String(res.failed) + ' 张' : '')
      )
      await refreshDetail(id)
      void load(true)
      onChanged()
    } finally {
      setPatchBusy(false)
    }
  }

  const exportPkg = async (id: number): Promise<void> => {
    if (!growthApi) return
    setPatchBusy(true)
    try {
      const res = await growthApi.exportPackage(id)
      if (!res.ok) {
        if (res.error !== '已取消导出') toast.error(res.error || '导出失败')
        return
      }
      toast.success('发布包已导出(' + String(res.files ?? 0) + ' 个文件)')
      const openFolder = window.api?.cs?.export?.openFolder
      if (res.dir && openFolder) void openFolder(res.dir)
    } finally {
      setPatchBusy(false)
    }
  }

  const ingestLink = useCallback(
    async (text: string): Promise<boolean> => {
      const link = text.trim()
      if (!growthApi || !link) return false
      setBusyIngest(true)
      try {
        const res = await growthApi.ingestLink(link)
        if (!res.ok) {
          toast.error(res.error || '入库失败')
          return false
        }
        toast.success(res.existed ? '该链接已入库(去重命中)' : '入库成功')
        void load(true)
        onChanged()
        return true
      } catch (e) {
        toast.error(e instanceof Error ? e.message : '入库失败')
        return false
      } finally {
        setBusyIngest(false)
      }
    },
    [load, onChanged]
  )

  const patch = async (
    id: number,
    patchData: { usage?: string; status?: string; note?: string }
  ): Promise<void> => {
    if (!growthApi) return
    setPatchBusy(true)
    try {
      const res = await growthApi.patchContent(id, patchData)
      if (!res.ok) {
        toast.error(res.error || '更新失败')
        return
      }
      toast.success('已更新')
      await refreshDetail(id)
      void load(true)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '更新失败')
    } finally {
      setPatchBusy(false)
    }
  }

  const removeItem = async (id: number): Promise<void> => {
    if (confirmRemove !== id) {
      setConfirmRemove(id)
      setTimeout(() => setConfirmRemove((v) => (v === id ? null : v)), 2500)
      return
    }
    if (!growthApi) return
    const res = await growthApi.removeContent(id)
    if (!res.ok) toast.error(res.error || '删除失败')
    else {
      toast.success('素材已删除')
      onChanged()
    }
    setConfirmRemove(null)
    setDetailId(null)
    setDetail(null)
    setSelected((prev) => {
      if (!prev.has(id)) return prev
      const next = new Set(prev)
      next.delete(id)
      return next
    })
    void load(true)
  }

  const filterActive = !!keyword.trim() || !!origin || !!usage

  const rowTitle = (it: GrowthContentItem): string =>
    it.title || (it.text ? it.text.slice(0, 80) : it.note || '(无标题素材)')

  return (
    <>
      <div className={'gth-ingest'}>
        <IngestBar busy={busyIngest} inputRef={ingestRef} onSubmit={ingestLink} />
        <button
          className={'ui-btn gth-btn'}
          type={'button'}
          disabled={uploading}
          title={'导入门店自有图片/视频(不进公域, 供爆改使用)'}
          onClick={() => void uploadLocal()}
        >
          {uploading ? '导入中…' : '上传本地素材'}
        </button>
      </div>

      <div className={'page-card gth-card'}>
        <div className={'gth-card-head'}>
          <span className={'gth-card-title'}>素材列表</span>
          <span className={'gth-card-sub'}>
            共 {total} 条{items.length < total ? ' · 已加载 ' + String(items.length) : ''} ·
            互动=赞/藏/评/转
          </span>
        </div>
        <div className={'gth-btn-row'} style={{ marginBottom: 10 }}>
          <SearchInput value={keyword} onApply={setKeyword} placeholder={'标题/正文/作者 检索'} />
          <select
            className={'ui-select gth-select'}
            style={{ width: 120 }}
            value={origin}
            onChange={(e) => setOrigin(e.target.value)}
          >
            <option value={''}>全部平台</option>
            <option value={'xhs'}>小红书</option>
            <option value={'douyin'}>抖音</option>
            <option value={'self'}>自有</option>
            <option value={'manual'}>手工</option>
          </select>
          <select
            className={'ui-select gth-select'}
            style={{ width: 120 }}
            value={usage}
            onChange={(e) => setUsage(e.target.value)}
          >
            <option value={''}>全部用途</option>
            <option value={'ref'}>内部参考</option>
            <option value={'own'}>自有素材</option>
            <option value={'licensed'}>已授权</option>
          </select>
          <select
            className={'ui-select gth-select'}
            style={{ width: 120 }}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value={''}>全部状态</option>
            <option value={'new'}>新入库</option>
            <option value={'ready'}>可爆改</option>
            <option value={'used'}>已爆改/已用</option>
            <option value={'archived'}>已归档</option>
          </select>
          <select
            className={'ui-select gth-select'}
            style={{ width: 120 }}
            value={sort}
            onChange={(e) => setSort(e.target.value as 'created' | 'score' | 'likes')}
          >
            <option value={'created'}>最新入库</option>
            <option value={'score'}>爆款分优先</option>
            <option value={'likes'}>点赞最多</option>
          </select>
          <button
            className={'gth-chip' + (noDecomp ? ' is-on' : '')}
            type={'button'}
            onClick={() => setNoDecomp((v) => !v)}
          >
            仅未拆解
          </button>
          {filterActive ? (
            <button
              className={'ui-btn gth-btn sm'}
              type={'button'}
              onClick={() => {
                setKeyword('')
                setOrigin('')
                setUsage('')
                setStatus('')
                setNoDecomp(false)
              }}
            >
              清除筛选
            </button>
          ) : null}
        </div>
        {selected.size > 0 ? (
          <div className={'gth-batchbar'}>
            <span>已选 {selected.size} 条</span>
            <select
              className={'ui-select gth-select'}
              style={{ width: 130 }}
              value={''}
              disabled={batchBusy}
              onChange={(e) => {
                if (e.target.value) void batchApply({ usage: e.target.value })
              }}
            >
              <option value={''}>批量改用途…</option>
              <option value={'ref'}>内部参考</option>
              <option value={'own'}>自有素材</option>
              <option value={'licensed'}>已授权</option>
            </select>
            <select
              className={'ui-select gth-select'}
              style={{ width: 130 }}
              value={''}
              disabled={batchBusy}
              onChange={(e) => {
                if (e.target.value) void batchApply({ status: e.target.value })
              }}
            >
              <option value={''}>批量改状态…</option>
              <option value={'new'}>新入库</option>
              <option value={'ready'}>可爆改</option>
              <option value={'used'}>已爆改/已用</option>
              <option value={'archived'}>已归档</option>
            </select>
            <button
              className={'ui-btn gth-btn sm'}
              type={'button'}
              disabled={batchBusy}
              title={'导出选中素材的发布包：只选一次目录，每条素材在下面各建一个子目录'}
              onClick={() => void batchExport()}
            >
              导出发布包（选中）
            </button>
            <button
              className={'ui-btn is-danger gth-btn sm'}
              type={'button'}
              disabled={batchBusy}
              onClick={() => void batchRemove()}
            >
              批量删除
            </button>
            <button
              className={'ui-btn gth-btn sm'}
              type={'button'}
              onClick={() => setSelected(new Set())}
            >
              取消选择
            </button>
          </div>
        ) : null}
        {loadErr ? <ErrBar msg={loadErr} onRetry={() => void load(true)} /> : null}
        {loading ? (
          <SkeletonRows rows={7} cols={2} />
        ) : items.length === 0 ? (
          filterActive ? (
            <EmptyState
              title={'没有符合筛选条件的素材'}
              steps={['换个关键词, 或点击「清除筛选」查看全部']}
              extra={
                <button
                  className={'ui-btn gth-btn sm'}
                  type={'button'}
                  onClick={() => {
                    setKeyword('')
                    setOrigin('')
                    setUsage('')
                    setStatus('')
                    setNoDecomp(false)
                  }}
                >
                  清除筛选
                </button>
              }
            />
          ) : (
            <EmptyState
              title={'素材仓库还是空的'}
              steps={[
                '粘贴小红书/抖音分享链接或口令, 或点「上传本地素材」导入门店实拍',
                '到「AI 工作台」点「+ 新建」选这条素材, 与 AI 对话逐项爆改成品牌文案',
                '在产出面板点「采用」收下满意的版本, 再用「导出发布包」把物料送出去'
              ]}
              extra={
                <button
                  className={'ui-btn gth-btn sm'}
                  type={'button'}
                  onClick={() => ingestRef.current?.focus()}
                >
                  去粘贴入库
                </button>
              }
            />
          )
        ) : (
          <div className={'gth-list'}>
            <div className={'gth-row gth-row--item is-head'}>
              <span>
                <input
                  type={'checkbox'}
                  checked={allSelected}
                  onChange={toggleAll}
                  title={'全选当前页'}
                />
              </span>
              <span>标题 / 内容</span>
              <span>平台 / 形态</span>
              <span className={'gth-eng-head'}>
                <em>赞</em>
                <em>藏</em>
                <em>评</em>
                <em>转</em>
              </span>
              <span>入库时间</span>
              <span className={'gth-col-right'}>爆款分</span>
              <span className={'gth-col-right'}>用途</span>
            </div>
            {items.map((it, i) => (
              <div
                className={
                  'gth-row gth-row--item clickable' + (detailId === it.id ? ' is-active' : '')
                }
                key={it.id}
                style={{ '--i': i } as React.CSSProperties}
                onClick={() => void openDetail(it.id)}
              >
                <span onClick={(e) => e.stopPropagation()}>
                  <input
                    type={'checkbox'}
                    checked={selected.has(it.id)}
                    onChange={() => toggleSelect(it.id)}
                    title={'选中以批量操作'}
                  />
                </span>
                <div className={'gth-main'}>
                  <div className={'t'}>
                    <span className={'txt'} title={rowTitle(it)}>
                      {rowTitle(it)}
                    </span>
                  </div>
                  <div className={'s'}>
                    {[it.authorName, it.tags.slice(0, 3).join(', ')].filter(Boolean).join(' · ') ||
                      '—'}
                  </div>
                </div>
                <div>
                  <Badge>
                    {ORIGIN_LABEL[it.origin] ?? it.origin} · {KIND_LABEL[it.kind] ?? it.kind}
                  </Badge>
                </div>
                {/* 互动拆成四格：此前是 1200/210/33/12 一串，读不出哪个是赞（列头也只写「赞/藏/评/转」） */}
                <div className={'gth-eng'}>
                  {(
                    [
                      ['赞', it.interactions.likes],
                      ['藏', it.interactions.collects],
                      ['评', it.interactions.comments],
                      ['转', it.interactions.shares]
                    ] as Array<[string, number]>
                  ).map(([label, n]) => (
                    <span key={label} title={label + ' ' + fmtNum(n)}>
                      {fmtNum(n)}
                    </span>
                  ))}
                </div>
                <div className={'gth-time'}>{fmt(it.createdAt)}</div>
                <div className={'gth-col-right gth-score'}>
                  {it.score > 0 ? Math.round(it.score) : '—'}
                </div>
                <div className={'gth-col-right'}>
                  <Badge tone={it.usage === 'ref' ? 'gray' : 'green'}>
                    {USAGE_LABEL[it.usage] ?? it.usage}
                  </Badge>
                </div>
              </div>
            ))}
            {hasMore ? (
              <div className={'gth-more'}>
                <button
                  className={'ui-btn gth-btn'}
                  type={'button'}
                  disabled={loadingMore}
                  onClick={() => void load(false)}
                >
                  {loadingMore
                    ? '加载中…'
                    : '加载更多(还有 ' + String(total - items.length) + ' 条)'}
                </button>
              </div>
            ) : null}
          </div>
        )}
      </div>

      {detailLoading ? (
        <div className={'page-card gth-card gth-detail-loading'}>加载详情…</div>
      ) : null}
      {detail ? (
        <div className={'gth-detail'} ref={detailRef}>
          <div className={'page-card gth-card'}>
            <div className={'gth-card-head'}>
              <span className={'gth-card-title'}>图文</span>
              <span className={'gth-card-sub'}>
                {
                  (detail.assets ?? []).filter((a) => a.kind === 'cover' || a.kind === 'image')
                    .length
                }{' '}
                张
              </span>
            </div>
            <MediaGallery
              key={'gallery-' + String(detail.id)}
              assets={detail.assets ?? []}
              remoteImageUrls={remoteImageUrlsOf(detail)}
              remoteVideoUrl={remoteVideoUrlOf(detail)}
              // 删图后重拉详情：张数、封面、画廊顺序都要跟着变（列表行的封面也来自这里）
              onChanged={() => void refreshDetail(detail.id)}
            />
          </div>
          <div className={'page-card gth-card gth-kv-card'}>
            {/* 详情头：标题当标题（原来标题是 dl 里的一行，头上写着「素材详情」），
                平台/作者/时间/ID 压成一行 meta，动作按钮按主次分三档。 */}
            <div className={'gth-detail-head'}>
              <div className={'gth-detail-title'}>
                <h3 className={'tt'} title={detail.title || '(无标题)'}>
                  {detail.title || '(无标题)'}
                </h3>
                <div className={'gth-detail-meta'}>
                  <Badge>
                    {ORIGIN_LABEL[detail.origin] ?? detail.origin} ·{' '}
                    {KIND_LABEL[detail.kind] ?? detail.kind}
                  </Badge>
                  {detail.authorName ? <span>{detail.authorName}</span> : null}
                  <span title={'入库时间'}>{fmt(detail.createdAt)} 入库</span>
                  {detail.platformItemId ? <span>ID {detail.platformItemId}</span> : null}
                  <span>#{detail.id}</span>
                  {detail.tags.length > 0 ? (
                    <span className={'tag'} title={'由系统写入（例如舆情入库会自动标记「舆情」）'}>
                      {detail.tags.join(' · ')}
                    </span>
                  ) : null}
                </div>
              </div>
              <span className={'gth-detail-btns'}>
                {/* 跨到 AI 工作台：这条素材若已有任务就直接切过去，没有就建一个（一个素材一个任务） */}
                {onOpenWorkbench ? (
                  <button
                    className={'ui-btn is-primary gth-btn sm'}
                    type={'button'}
                    title={'在「AI 工作台」里爆改这条素材（已有任务直接切过去）'}
                    onClick={() => onOpenWorkbench(detail.id)}
                  >
                    用 AI 爆改
                  </button>
                ) : null}
                <button
                  className={'ui-btn gth-btn sm'}
                  type={'button'}
                  disabled={patchBusy}
                  onClick={() => void exportPkg(detail.id)}
                >
                  导出发布包
                </button>
                {/* 次要动作用 is-quiet：常态是文字，hover 才显出按钮边界（原来五个按钮一样重） */}
                <button
                  className={'ui-btn gth-btn sm is-quiet'}
                  type={'button'}
                  disabled={patchBusy}
                  title={'本地图片缺失时按源链接重新下载'}
                  onClick={() => void redownload(detail.id)}
                >
                  重下图片
                </button>
                <button
                  className={
                    'ui-btn is-danger gth-btn sm is-quiet' +
                    (confirmRemove === detail.id ? ' is-solid' : '')
                  }
                  type={'button'}
                  disabled={patchBusy}
                  onClick={() => void removeItem(detail.id)}
                >
                  {confirmRemove === detail.id ? '确认删除?' : '删除'}
                </button>
                <button
                  className={'ui-btn gth-btn sm is-quiet'}
                  type={'button'}
                  title={'收起详情'}
                  onClick={() => {
                    setDetailId(null)
                    setDetail(null)
                  }}
                >
                  收起
                </button>
              </span>
            </div>
            {/* 互动四格：原来是一行「赞 1200 · 藏 210 · 评 33 · 转 12」，扫数字要逐字读 */}
            <div className={'gth-detail-eng'}>
              {(
                [
                  ['赞', detail.interactions.likes],
                  ['藏', detail.interactions.collects],
                  ['评', detail.interactions.comments],
                  ['转', detail.interactions.shares]
                ] as Array<[string, number]>
              ).map(([label, n]) => (
                <div className={'cell'} key={label}>
                  <span className={'k'}>{label}</span>
                  <span className={'v'}>{fmtNum(n)}</span>
                </div>
              ))}
            </div>

            {detail.text ? (
              <div className={'gth-detail-text'}>
                <p className={textOpen ? '' : 'is-clamp'}>
                  {textOpen ? detail.text : detail.text.slice(0, 160)}
                </p>
                <div className={'acts'}>
                  {detail.text.length > 160 ? (
                    <button
                      className={'ui-link'}
                      type={'button'}
                      onClick={() => setTextOpen((v) => !v)}
                    >
                      {textOpen ? '收起正文' : '展开全文'}
                    </button>
                  ) : null}
                  <button
                    className={'ui-link'}
                    type={'button'}
                    onClick={() => void copyTextRow(detail.text)}
                  >
                    复制正文
                  </button>
                </div>
              </div>
            ) : null}

            <div className={'gth-detail-foot'}>
              {detail.link ? (
                <a className={'link'} href={detail.link} target={'_blank'} rel={'noreferrer'}>
                  {detail.link}
                </a>
              ) : (
                <span className={'muted'}>无原链接</span>
              )}
              <span className={'muted'}>
                {detail.assets.length} 个文件 · {detail.decomp ? '已拆解' : '待拆解'}
                {detail.publishedAt ? ' · 发布 ' + fmt(detail.publishedAt) : ''}
              </span>
            </div>
            <div className={'gth-ops'}>
              {/* 用途/状态改成胶囊切换：两个各 3~4 项的短枚举，用下拉要多一次点击还看不到可选项 */}
              <div className={'gth-ops-row'}>
                <span className={'gth-ops-fld'}>
                  <span className={'lb'}>用途</span>
                  <span className={'gth-pills'}>
                    {USAGE_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        className={'ui-pill' + (detail.usage === opt.value ? ' is-on' : '')}
                        type={'button'}
                        disabled={patchBusy}
                        title={opt.hint}
                        onClick={() => void patch(detail.id, { usage: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </span>
                </span>
                <span className={'gth-ops-fld'}>
                  <span className={'lb'}>状态</span>
                  <span className={'gth-pills'}>
                    {STATUS_OPTIONS.map((opt) => (
                      <button
                        key={opt.value}
                        className={'ui-pill' + (detail.status === opt.value ? ' is-on' : '')}
                        type={'button'}
                        disabled={patchBusy}
                        onClick={() => void patch(detail.id, { status: opt.value })}
                      >
                        {opt.label}
                      </button>
                    ))}
                  </span>
                </span>
              </div>
              <div className={'gth-ops-row'}>
                <label className={'gth-ops-fld grow'}>
                  <span className={'lb'}>内部备注</span>
                  <textarea
                    className={'ui-textarea gth-input gth-input--area'}
                    rows={2}
                    value={noteDraft}
                    disabled={patchBusy}
                    placeholder={'来源说明 / 待补全事项 / 跟进信息'}
                    onChange={(e) => setNoteDraft(e.target.value)}
                  />
                </label>
                <button
                  className={'ui-btn gth-btn sm'}
                  type={'button'}
                  disabled={patchBusy || noteDraft === detail.note}
                  onClick={() => void patch(detail.id, { note: noteDraft })}
                >
                  {patchBusy ? '保存中…' : '保存备注'}
                </button>
              </div>
              <div className={'gth-ops-hint'}>
                仅内部可见; 来源为「内部参考」的素材只能用于学习分析, 对外发布先到「AI
                工作台」原创化处理。
              </div>
            </div>

            {/* 拆解卡：AI 从这条爆款里读出了什么（结构 + 视觉），此前只有一枚徽标 */}
            <DecompCard decomp={detail.decomp} />

            {/* 注: 「发布登记 + 效果历史」表单已按用户决定整体下线（纯手工录数字，运营不会去填） */}
          </div>
        </div>
      ) : null}
    </>
  )
}

// ── 页面外壳 ──
