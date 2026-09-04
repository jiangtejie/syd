import { useEffect, useMemo, useRef, useState } from 'react'
import type { PhraseItem, PhraseInput } from '../../../../shared/types'
import { toast } from '../../stores/toast'

/**
 * 话术库快速插入面板（发送栏入口）。
 * 搜索/插入/增删改一体；插入时替换 {客户} 变量；插入成功计一次用量。
 */

const phraseApi = window.api?.cs?.phrase

function replaceVars(content: string, customerName: string): string {
  const name = customerName || '客户'
  return content.replace(/\{客户\}|\{name\}/g, name)
}

interface PhrasePickerProps {
  customerName: string
  onUse: (content: string) => void
  onClose: () => void
}

export default function PhrasePicker({
  customerName,
  onUse,
  onClose
}: PhrasePickerProps): React.JSX.Element {
  const [items, setItems] = useState<PhraseItem[]>([])
  const [q, setQ] = useState('')
  const [loading, setLoading] = useState(true)
  // 编辑态：null=列表浏览；editId>0 编辑；'new'=新建
  const [editId, setEditId] = useState<number | 'new' | null>(null)
  const [form, setForm] = useState<PhraseInput>({ title: '', content: '', tags: '' })
  const [saving, setSaving] = useState(false)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const load = async (keyword?: string): Promise<void> => {
    const res = await phraseApi?.list(keyword ?? q).catch(() => null)
    if (res?.ok && res.phrases) setItems(res.phrases as PhraseItem[])
    setLoading(false)
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取话术列表（全仓同款模式）
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 搜索防抖
  useEffect(() => {
    if (loading) return
    const t = window.setTimeout(() => void load(q), 250)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q])

  const openNew = (): void => {
    setEditId('new')
    setForm({ title: '', content: '', tags: '' })
  }
  const openEdit = (it: PhraseItem): void => {
    setEditId(it.id)
    setForm({ title: it.title, content: it.content, tags: it.tags ?? '' })
  }
  const cancelEdit = (): void => {
    setEditId(null)
  }

  const save = async (): Promise<void> => {
    if (!phraseApi) return
    if (!form.title.trim() || !form.content.trim()) {
      toast.error('标题与内容不能为空')
      return
    }
    setSaving(true)
    try {
      const res = await phraseApi
        .save({ id: editId === 'new' ? undefined : (editId ?? undefined), ...form })
        .catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '保存失败')
        return
      }
      toast.success('话术已保存')
      setEditId(null)
      await load(q)
    } finally {
      setSaving(false)
    }
  }

  const remove = async (it: PhraseItem): Promise<void> => {
    if (!window.confirm(`删除话术「${it.title}」？`)) return
    const res = await phraseApi?.remove(it.id).catch(() => null)
    if (!res?.ok) {
      toast.error((res as { error?: string } | null)?.error || '删除失败')
      return
    }
    toast.success('已删除')
    if (editId === it.id) setEditId(null)
    await load(q)
  }

  const insert = (it: PhraseItem): void => {
    void phraseApi?.use(it.id)
    onUse(replaceVars(it.content, customerName))
    toast.success('已插入话术（{客户} 已替换）')
  }

  const editingItem = useMemo(
    () => (typeof editId === 'number' ? items.find((x) => x.id === editId) : undefined),
    [editId, items]
  )

  return (
    <div className="wb-phrase" role="dialog" aria-label="话术库">
      <div className="wb-phrase-head">
        <span className="wb-phrase-title">话术库</span>
        <input
          ref={searchRef}
          className="wb-phrase-search"
          placeholder="搜索标题/内容/标签…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <button type="button" className="wb-phrase-add" onClick={openNew}>
          + 新建
        </button>
        <button type="button" className="wb-phrase-x" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>

      <div className="wb-phrase-body">
        {loading && <div className="wb-phrase-empty">加载中…</div>}
        {!loading && items.length === 0 && (
          <div className="wb-phrase-empty">
            {q.trim() ? '没有匹配的话术' : '暂无话术，点「+ 新建」沉淀团队口径'}
          </div>
        )}
        {items.map((it) => (
          <div key={it.id} className={`wb-phrase-item${editId === it.id ? ' is-edit' : ''}`}>
            <div className="wb-phrase-item-main">
              <div className="wb-phrase-item-title">
                <b>{it.title}</b>
                {it.tags &&
                  it.tags
                    .split(/[,\s，]+/)
                    .filter(Boolean)
                    .map((t) => (
                      <em key={t} className="wb-phrase-tag">
                        {t}
                      </em>
                    ))}
                <span className="wb-phrase-usage">用 {it.usageCount} 次</span>
              </div>
              <div className="wb-phrase-item-content">{it.content}</div>
            </div>
            <div className="wb-phrase-item-ops">
              <button type="button" className="wb-btn-phrase primary" onClick={() => insert(it)}>
                插入
              </button>
              <button type="button" className="wb-btn-phrase" onClick={() => openEdit(it)}>
                编辑
              </button>
              <button
                type="button"
                className="wb-btn-phrase danger"
                onClick={() => void remove(it)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {editId !== null && (
        <div className="wb-phrase-edit">
          <input
            className="wb-phrase-input"
            placeholder="标题（如：发货延迟致歉+补偿口径）"
            value={form.title}
            onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          />
          <input
            className="wb-phrase-input"
            placeholder="标签，空格/逗号分隔（如：物流 道歉 补偿）"
            value={form.tags ?? ''}
            onChange={(e) => setForm((f) => ({ ...f, tags: e.target.value }))}
          />
          <textarea
            className="wb-phrase-textarea"
            rows={4}
            placeholder={'话术正文。{客户} 会在插入时替换为当前客户称呼。'}
            value={form.content}
            onChange={(e) => setForm((f) => ({ ...f, content: e.target.value }))}
          />
          <div className="wb-phrase-edit-ops">
            <span className="wb-phrase-edit-hint">
              {editingItem ? `正在编辑「${editingItem.title}」` : '新建话术'}
            </span>
            <button type="button" className="wb-btn-phrase" onClick={cancelEdit}>
              取消
            </button>
            <button
              type="button"
              className="wb-btn-phrase primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
