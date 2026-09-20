/** 收尾核对：迁移是否真的落到线上库、产出写入是否恢复、拆解是否已带视觉事实 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const src = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
const tmp = join(tmpdir(), 'cs-final-' + Date.now() + '.db')
copyFileSync(src, tmp)
for (const ext of ['-wal', '-shm']) if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext)
const db = new Database(tmp, { readonly: true })
const ts = (n) => (n ? new Date(Number(n)).toLocaleString('zh-CN', { hour12: false }) : '-')
try {
  console.log('user_version =', db.pragma('user_version', { simple: true }), '（代码里 SCHEMA_VERSION = 7）')
  const cols = db.prepare('PRAGMA table_info(growth_remix_output)').all()
  const job = cols.find((c) => c.name === 'job_id')
  console.log('job_id 列:', job ? '仍在, notnull=' + String(job.notnull) + (job.notnull === 0 ? ' ✓ 已放宽' : ' ✗ 仍是 NOT NULL') : '已不存在')
  const outs = db.prepare('SELECT id, task_id, variant, status, created_at FROM growth_remix_output ORDER BY id DESC LIMIT 5').all()
  console.log('最近产出:', outs.length === 0 ? '(无)' : outs.map((o) => '#' + o.id + ' task=' + o.task_id + ' ' + o.variant + ' ' + ts(o.created_at)).join(' | '))
  const imgs = db.prepare("SELECT id, content_id, source_mark, created_at FROM growth_asset ORDER BY id DESC LIMIT 4").all()
  console.log('最近图片:', imgs.map((a) => '#' + a.id + ' ' + a.source_mark + ' ' + ts(a.created_at)).join(' | '))
  const dec = db.prepare('SELECT content_id, model_ver, visual_json, created_at FROM growth_decomp ORDER BY id DESC LIMIT 3').all()
  for (const d of dec) {
    const v = (() => { try { return JSON.parse(d.visual_json || '{}') } catch { return {} } })()
    console.log('拆解 素材#' + d.content_id, d.model_ver, ts(d.created_at), '视觉字段:', Object.keys(v).filter((k) => v[k] && (!Array.isArray(v[k]) || v[k].length)).join(',') || '(空)')
  }
} finally { db.close() }
