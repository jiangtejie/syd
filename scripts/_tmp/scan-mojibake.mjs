import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
const BAD = ['锛','鐨','鈥','銆','鍜','鏄','涓','瑙','瘑','灞','傛','彁','绀','鏂','浠','婧','鍥','鐣','鏍','瀹','鎴','绾','缂','鍏','閰','閲','鐜','鍣','鐢','鎬','鐞','鎵','缁','鍒','鍗','鍐','鎶','鎻','鐗','鏉','鏄','鐩','鐪','鎰','瀵','瀹','娴','娴','鐐','鐔','鐨','鐫']
const files = []
function walk(d) {
  for (const e of readdirSync(d)) {
    const p = join(d, e)
    const st = statSync(p)
    if (st.isDirectory()) walk(p)
    else if (/\.(css|ts|tsx|mjs|json|md)$/.test(e)) files.push(p)
  }
}
walk('src')
let total = 0
for (const f of files) {
  const t = readFileSync(f, 'utf8')
  let n = 0
  for (const c of BAD) n += t.split(c).length - 1
  if (n > 0) { console.log(f + ' : ' + n); total += n }
}
console.log('总计可疑字符: ' + total + '（文件数 ' + files.length + '）')
