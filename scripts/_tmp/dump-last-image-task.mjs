/** 只读导出：最近一次图文改写的任务/产出/图片/工具回执（复制到临时目录，不碰线上库） */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const appData = process.env.APPDATA || ''
const src = join(appData, 'wechat-cs-desktop', 'cs.db')
const work = mkdtempSync(join(tmpdir(), 'cs-read-'))
for (const ext of ['', '-wal', '-shm']) {
  const f = src + ext
  if (existsSync(f)) copyFileSync(f, join(work, 'cs.db' + ext))
}
const db = new Database(join(work, 'cs.db'), { readonly: true })
const j = (v) => JSON.stringify(v)
try {
  console.log('== 最近任务 ==')
  const tasks = db.prepare('SELECT id, content_id, title, goal, status, session_id, summary, updated_at FROM growth_ai_task ORDER BY updated_at DESC LIMIT 3').all()
  console.log(j(tasks))
  const t = tasks[0]
  console.log('== 该任务产出（按时间倒序）==')
  const outs = db.prepare('SELECT id, variant, status, created_at, substr(title,1,60) AS title, substr(copy_text,1,60) AS copy, meta_json FROM growth_remix_output WHERE task_id = ? ORDER BY id DESC LIMIT 8').all(t.id)
  for (const o of outs) {
    const meta = (() => { try { return JSON.parse(o.meta_json) } catch { return {} } })()
    console.log('#' + o.id, o.variant, o.status, '| meta keys:', Object.keys(meta).join(','))
  }
  console.log('== 图片挂载 ==')
  const assets = db.prepare("SELECT oa.id, oa.output_id, oa.role, oa.source, oa.note, a.id AS aid, a.rel_path, a.kind, a.width, a.height, a.size, a.mime, oa.created_at FROM growth_output_asset oa LEFT JOIN growth_asset a ON a.id = oa.asset_id WHERE oa.output_id IN (SELECT id FROM growth_remix_output WHERE task_id = ?) ORDER BY oa.id DESC LIMIT 12").all(t.id)
  for (const a of assets) console.log(j(a))
  console.log('== 素材与其本地图 ==')
  const c = db.prepare('SELECT id, kind, origin, title, link FROM growth_content WHERE id = ?').get(t.content_id)
  console.log(j(c))
  const ca = db.prepare('SELECT id, kind, rel_path, width, height, size, source_mark, created_at FROM growth_asset WHERE content_id = ? ORDER BY id').all(t.content_id)
  for (const a of ca) console.log(j(a))
  console.log('== 该会话工具回执（最近 12 条）==')
  const msgs = db.prepare("SELECT id, role, kind, substr(content,1,120) AS content, meta, created_at FROM chat_message WHERE session_id = ? AND kind = 'tool_call' ORDER BY id DESC LIMIT 12").all(t.session_id)
  for (const m of msgs) {
    const meta = (() => { try { return JSON.parse(m.meta) } catch { return {} } })()
    console.log('#' + m.id, meta.name, meta.status, '| args:', String(meta.args).slice(0, 160), '| out:', String(meta.output).slice(0, 400))
  }
} finally { db.close() }
