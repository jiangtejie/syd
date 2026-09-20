/** 会话 4 / 任务 5 的时间线与全部工具回执（含被截断以外的完整内容），以及最近的图片资产 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, mkdtempSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const appData = process.env.APPDATA || ''
const src = join(appData, 'wechat-cs-desktop', 'cs.db')
const work = mkdtempSync(join(tmpdir(), 'cs-read2-'))
for (const ext of ['', '-wal', '-shm']) {
  const f = src + ext
  if (existsSync(f)) copyFileSync(f, join(work, 'cs.db' + ext))
}
const db = new Database(join(work, 'cs.db'), { readonly: true })
const ts = (n) => (n ? new Date(Number(n)).toLocaleString('zh-CN', { hour12: false }) : '-')
try {
  console.log('== 会话 4 的消息时间线（文本 + 工具）==')
  const rows = db.prepare("SELECT id, role, kind, content, meta, created_at FROM chat_message WHERE session_id = 4 ORDER BY id").all()
  for (const r of rows) {
    const meta = (() => { try { return JSON.parse(r.meta) } catch { return null } })()
    if (r.kind === 'tool_call') {
      console.log('#' + r.id, ts(r.created_at), '[' + (meta?.name ?? '?') + ' ' + (meta?.status ?? '') + ']')
      console.log('    args:', String(meta?.args ?? '').slice(0, 300))
      console.log('    out :', String(meta?.output ?? '').slice(0, 700))
    } else {
      console.log('#' + r.id, ts(r.created_at), r.role + '/' + r.kind + ':', String(r.content ?? '').slice(0, 220).replace(/\n/g, ' ⏎ '))
    }
  }
  console.log('')
  console.log('== 全库最近的图片资产（20 条）==')
  const assets = db.prepare("SELECT id, content_id, kind, rel_path, width, height, size, source_mark, created_at FROM growth_asset ORDER BY id DESC LIMIT 20").all()
  for (const a of assets) console.log('#' + a.id, ts(a.created_at), a.kind, a.width + 'x' + a.height, Math.round(a.size / 1024) + 'KB', a.source_mark, a.rel_path)
  console.log('')
  console.log('== 全库最近的产出（12 条）==')
  const outs = db.prepare('SELECT id, task_id, content_id, variant, status, created_at, substr(title,1,40) AS t FROM growth_remix_output ORDER BY id DESC LIMIT 12').all()
  for (const o of outs) console.log('#' + o.id, ts(o.created_at), 'task=' + o.task_id, o.variant, o.status, o.t)
} finally { db.close() }
