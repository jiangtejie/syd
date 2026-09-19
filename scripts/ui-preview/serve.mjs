/** 静态服务 out/renderer（UI 预览用）：node scripts/ui-preview/serve.mjs [port] */
import { createServer } from 'http'
import { readFile, stat } from 'fs/promises'
import { join, extname, normalize } from 'path'
import { dirname } from 'path'
import { fileURLToPath } from 'url'

const here = dirname(fileURLToPath(import.meta.url))
const rootDir = join(here, '..', '..', 'out', 'renderer')
const port = Number(process.argv[2] || 5199)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.json': 'application/json' }

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x')
    let p = normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '')
    if (p === '' ) p = 'preview.html'
    const file = join(rootDir, p)
    if (!file.startsWith(rootDir)) { res.writeHead(403).end('forbidden'); return }
    const st = await stat(file)
    if (st.isDirectory()) { res.writeHead(404).end('not found'); return }
    const buf = await readFile(file)
    res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(buf)
  } catch (e) {
    res.writeHead(404).end('not found: ' + String(e && e.message))
  }
}).listen(port, '127.0.0.1', () => console.log('ui-preview server: http://127.0.0.1:' + port + '/preview.html'))
