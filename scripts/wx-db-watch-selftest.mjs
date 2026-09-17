import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 微信库「变化口径」与副本增量刷新判定自检（纯函数）。
 *
 * 钉住两件事：
 *  ① 监控必须把 -wal 也算成变化，但对外只能报**库文件本身**（报 -wal 会让下游按路径判定的逻辑全部失配）；
 *  ② 明文副本只有在「主库没动、只有 WAL 追加」时才允许增量合并 —— 主库动过就必须整库重解，
 *     否则会把主库的新内容漏掉（读到过期数据，且看不出异常）。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-dbfile-watch-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'dbFileWatch.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/wechat/dbFileWatch.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { logicalDbFileOf, isWalOf, watchedDbFiles, shouldRefreshFromWal } = require(bundle)

  const msgDb = 'C:/wx/db_storage/message/message_0.db'
  const sesDb = 'C:/wx/db_storage/session/session.db'
  const files = [msgDb, sesDb]

  console.log('附属文件归一：')
  ok(logicalDbFileOf(msgDb, files) === msgDb, '库文件本身 → 自己')
  ok(logicalDbFileOf(msgDb + '-wal', files) === msgDb, '-wal → 库文件（对外只报库文件）')
  ok(logicalDbFileOf(msgDb + '-shm', files) === msgDb, '-shm → 库文件')
  ok(logicalDbFileOf('C:/wx/db_storage/message/message_1.db', files) === null, '不在名单里的库 → null（不误报）')
  ok(logicalDbFileOf(msgDb + '-wal2', files) === null, '形近但不是 -wal → null')
  ok(logicalDbFileOf('C:/WX/DB_STORAGE/MESSAGE/MESSAGE_0.DB-WAL', files) === msgDb, '大小写/斜杠差异仍能对上')

  console.log('WAL 识别（决定要不要按冷却节流）：')
  ok(isWalOf(msgDb + '-wal', files) === true, '-wal 判定为 WAL 变化')
  ok(isWalOf(msgDb, files) === false, '主库变化不算 WAL（不节流，立即通知）')
  ok(isWalOf(msgDb + '-shm', files) === false, '-shm 不算 WAL 变化')

  console.log('要盯的文件清单：')
  const watched = watchedDbFiles(files)
  ok(watched.length === 4, '每个库各带一个 -wal', String(watched.length))
  ok(watched.includes(msgDb + '-wal') && watched.includes(sesDb + '-wal'), '两库的 WAL 都在清单里')

  console.log('副本增量刷新的判据（保守优先）：')
  const t = (mtimeMs, size) => ({ mtimeMs, size })
  ok(shouldRefreshFromWal(t(100, 1000), t(100, 1000)) === true, '主库没动、WAL 有新帧 → 走增量')
  ok(shouldRefreshFromWal(t(100, 1000), t(200, 1000)) === true, '副本比主库新 → 走增量')
  ok(shouldRefreshFromWal(t(200, 1000), t(100, 1000)) === false, '主库比副本新（checkpoint 写过页）→ 必须整库重解')
  ok(shouldRefreshFromWal(t(100, 2000), t(100, 1000)) === false, '副本比主库小 → 整库重解')
  ok(shouldRefreshFromWal(t(100, 1000), t(100, 0)) === false, '副本为空 → 不算可用')
  ok(shouldRefreshFromWal(null, t(100, 1000)) === false, '源库读不到 → 不增量')
  ok(shouldRefreshFromWal(t(100, 1000), null) === false, '副本不存在 → 不增量（要走首次解密）')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
