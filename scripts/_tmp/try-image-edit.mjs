/**
 * 实测「高仿生图」到底行不行：拿真实原图 + 最强口径的"保持一切、只换文字"提示词，走一次 /images/edits。
 * 只在临时目录里操作，不碰线上库（密钥用 safeStorage 现场解封，不落盘）。
 * 用法: npx electron scripts/_tmp/try-image-edit.mjs <原图路径> <输出目录>
 */
import { app, safeStorage } from 'electron'
import Database from 'better-sqlite3-multiple-ciphers'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const refPath = process.argv[2]
const outDir = process.argv[3] || join(tmpdir(), 'edit-test')
mkdirSync(outDir, { recursive: true })

/**
 * safeStorage 用的是 per-userData 的 OSCrypt key：脚本用 npx electron 起，
 * userData 默认是 %APPDATA%/Electron，跟应用（wechat-cs-desktop）不是同一个 —— 不改就解不开密钥。
 * 必须在 whenReady 之前改。
 */
app.setPath('userData', join(app.getPath('appData'), 'wechat-cs-desktop'))

function openSecret(stored) {
  if (!stored) return ''
  if (!stored.startsWith('enc1:')) return stored
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(5), 'base64'))
  } catch (e) {
    console.error('解密失败:', String(e))
    return ''
  }
}

app.whenReady().then(async () => {
  const work = join(tmpdir(), 'cs-keycopy-' + Date.now())
  mkdirSync(work, { recursive: true })
  const dbPath = join(work, 'cs.db')
  const src = join(app.getPath('appData'), 'wechat-cs-desktop', 'cs.db')
  copyFileSync(src, dbPath)
  const db = new Database(dbPath, { readonly: true })
  const get = (k) => { const r = db.prepare('SELECT value FROM app_config WHERE key = ?').get(k); return r ? r.value : null }
  const cfg = {
    baseUrl: String(get('growth.image.baseUrl') || '').replace(/\/+$/, ''),
    model: String(get('growth.image.model') || ''),
    key: openSecret(get('growth.image.apiKey'))
  }
  db.close()
  console.log('通道:', cfg.baseUrl, '| 模型:', cfg.model, '| key:', cfg.key ? cfg.key.slice(0, 6) + '…(' + cfg.key.length + ')' : '(空)')
  if (!cfg.key || !cfg.baseUrl) { console.error('缺 key/baseUrl'); app.quit(); return }

  const buf = readFileSync(refPath)
  const ext = refPath.split('.').pop()
  const mime = ext === 'webp' ? 'image/webp' : ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : 'image/png'
  console.log('原图:', refPath, Math.round(buf.length / 1024) + 'KB', mime)

  const prompt = [
    '严格保持这张图的构图、机位、光线、色调、版式、字体风格，以及**每一处文字的位置、大小、对齐方式完全不变**；',
    '只把画面上的文字内容替换成下面这几行中文（必须逐字准确、笔画完整、不要出现乱码或错别字）：',
    '主标题：国庆来重庆，观音桥这家老重庆牛油锅别错过',
    '副标题：甜品免费 · 人均98',
    '角标：观音桥',
    '除文字内容以外，不要改变画面里的任何元素（菜品、桌面、背景、装饰都保持原样）。'
  ].join('\n')

  const form = new FormData()
  form.append('model', cfg.model)
  form.append('prompt', prompt)
  form.append('n', '2')
  form.append('size', '1024x1536')
  form.append('image', new Blob([new Uint8Array(buf)], { type: mime }), 'ref.' + ext)

  const t0 = Date.now()
  try {
    const res = await fetch(cfg.baseUrl + '/images/edits', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + cfg.key },
      body: form
    })
    const text = await res.text()
    console.log('HTTP', res.status, Math.round((Date.now() - t0) / 1000) + 's', '| 响应前 200 字:', text.slice(0, 200))
    if (!res.ok) { app.quit(); return }
    const parsed = JSON.parse(text)
    const items = Array.isArray(parsed.data) ? parsed.data : []
    console.log('返回图片数:', items.length)
    items.forEach((it, i) => {
      const p = join(outDir, 'edit-' + String(i + 1) + '.png')
      if (it.b64_json) writeFileSync(p, Buffer.from(it.b64_json, 'base64'))
      else if (it.url) console.log('  (url 形式，未下载)', it.url)
      if (existsSync(p)) console.log('  写出', p, Math.round(readFileSync(p).length / 1024) + 'KB')
      if (it.revised_prompt) console.log('  revised_prompt:', String(it.revised_prompt).slice(0, 160))
    })
  } catch (e) {
    console.error('请求失败:', String(e))
  }
  app.quit()
})
