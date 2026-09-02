import { readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const base = 'C:\\Users\\Administrator\\Documents\\xwechat_files\\wxid_r9l5xuni9ng522_7e0b'
if (!existsSync(base)) {
  console.log('不存在:', base)
  process.exit(0)
}
const out = []
function walk(dir, depth) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const x of entries) {
    const full = join(dir, x.name)
    if (x.isDirectory()) {
      if (['msg', 'attach', 'video', 'image', 'file', 'db_storage', 'session', 'message', 'contact', 'favorite', 'media'].includes(x.name.toLowerCase())) {
        out.push('D ' + full)
        walk(full, depth + 1)
      }
    } else if (x.isFile() && /\.(dat)$/i.test(x.name)) {
      let sz = 0
      try { sz = statSync(full).size } catch { }
      out.push('F ' + full + ' (' + (sz / 1024).toFixed(0) + 'KB)')
    }
  }
}
walk(base, 0)
console.log(out.slice(0, 100).join('\n') || '(empty)')
console.log('--- total dat files:', out.filter((l) => l.startsWith('F ')).length)
