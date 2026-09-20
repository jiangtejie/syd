/** 评估素材：当前用的模型/通道 + 拆解卡是否真的拆出了画面事实 + 图片通道能力配置 */
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
const src = join(process.env.APPDATA || '', 'wechat-cs-desktop', 'cs.db')
const tmp = join(tmpdir(), 'cs-eval-' + Date.now() + '.db')
copyFileSync(src, tmp)
for (const ext of ['-wal', '-shm']) if (existsSync(src + ext)) copyFileSync(src + ext, tmp + ext)
const db = new Database(tmp, { readonly: true })
const get = (k) => { const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get(k); return r ? r.value : null }
const mask = (v) => (v ? String(v).slice(0, 8) + '…(' + String(v).length + ')' : null)
try {
  console.log('== AI 文本通道 ==')
  for (const k of ['ai.enabled', 'ai.baseUrl', 'ai.model', 'ai.maxOutputTokens']) console.log(' ', k, '=', k.includes('baseUrl') ? get(k) : get(k))
  console.log('  ai.apiKey =', mask(get('ai.apiKey')))
  console.log('== 生图通道 ==')
  for (const k of ['growth.image.enabled', 'growth.image.baseUrl', 'growth.image.model', 'growth.image.size', 'growth.image.count', 'growth.image.monthlyLimit', 'growth.image.platform']) console.log(' ', k, '=', k.includes('baseUrl') ? get(k) : get(k))
  console.log('  growth.image.apiKey =', mask(get('growth.image.apiKey')), '| templates =', String(get('growth.image.templates') ?? '').slice(0, 80))
  console.log('== 拆解卡（最近 4 条）==')
  const rows = db.prepare('SELECT content_id, model_ver, visual_json, created_at FROM growth_decomp ORDER BY id DESC LIMIT 4').all()
  for (const r of rows) {
    const v = (() => { try { return JSON.parse(r.visual_json || '{}') } catch { return {} } })()
    const keys = Object.keys(v).filter((k) => v[k] && (!Array.isArray(v[k]) || v[k].length))
    console.log('  素材#' + r.content_id, r.model_ver, new Date(Number(r.created_at)).toLocaleString('zh-CN', { hour12: false }), '视觉字段:', keys.join(',') || '(空)')
    if (keys.length) console.log('     ', JSON.stringify(v).slice(0, 320))
  }
} finally { db.close() }
