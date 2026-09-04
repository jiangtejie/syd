import { getDb } from '../database'
import type { PhraseItem, PhraseInput } from '../../../shared/types'

/**
 * phrase_book（话术库模板）持久化。
 * 团队固定口径模板：标题/内容/标签/用量计数；插入时由调用方做 {客户} 等变量替换。
 */

interface PhraseRow {
  id: number
  title: string
  content: string
  tags: string
  usage_count: number
  created_at: number
  updated_at: number
}

function rowToPhrase(r: PhraseRow): PhraseItem {
  return {
    id: r.id,
    title: r.title,
    content: r.content,
    tags: r.tags || undefined,
    usageCount: r.usage_count,
    createdAt: r.created_at,
    updatedAt: r.updated_at
  }
}

/** 列表（标题/内容/标签关键词搜索，空 q = 全量按最近更新倒序） */
export function listPhrases(q = '', limit = 100): PhraseItem[] {
  const like = `%${q.trim()}%`
  const rows = (
    q.trim()
      ? getDb()
          .prepare(
            `SELECT * FROM phrase_book
             WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
             ORDER BY updated_at DESC LIMIT ?`
          )
          .all(like, like, like, limit)
      : getDb().prepare(`SELECT * FROM phrase_book ORDER BY updated_at DESC LIMIT ?`).all(limit)
  ) as PhraseRow[]
  return rows.map(rowToPhrase)
}

/** 保存（新建或更新，去重标题） */
export function savePhrase(input: PhraseInput): { ok: boolean; error?: string; item?: PhraseItem } {
  const title = (input.title || '').trim()
  const content = (input.content || '').trim()
  if (!title || !content) return { ok: false, error: '标题与内容不能为空' }
  const db = getDb()
  const now = Date.now()
  const dup = db
    .prepare(`SELECT id FROM phrase_book WHERE title = ? AND (? IS NULL OR id != ?) LIMIT 1`)
    .get(title, input.id ?? null, input.id ?? null) as { id: number } | undefined
  if (dup) return { ok: false, error: `已存在同名话术「${title}」` }
  if (input.id) {
    const info = db
      .prepare(
        `UPDATE phrase_book SET title = ?, content = ?, tags = ?, updated_at = ? WHERE id = ?`
      )
      .run(title, content, (input.tags ?? '').trim(), now, input.id)
    if (info.changes === 0) return { ok: false, error: '话术不存在' }
  } else {
    db.prepare(
      `INSERT INTO phrase_book (title, content, tags, usage_count, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    ).run(title, content, (input.tags ?? '').trim(), now, now)
  }
  const row = db
    .prepare(`SELECT * FROM phrase_book WHERE title = ? ORDER BY id DESC LIMIT 1`)
    .get(title) as PhraseRow | undefined
  return row ? { ok: true, item: rowToPhrase(row) } : { ok: false, error: '保存失败' }
}

export function removePhrase(id: number): boolean {
  const info = getDb().prepare(`DELETE FROM phrase_book WHERE id = ?`).run(id)
  return info.changes > 0
}

/** 插入一次 → 用量 +1（用于“常用话术”排序/统计） */
export function bumpPhraseUsage(id: number): void {
  getDb().prepare(`UPDATE phrase_book SET usage_count = usage_count + 1 WHERE id = ?`).run(id)
}
