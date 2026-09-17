import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 微信消息表命中判定自检（纯函数）。
 *
 * 钉住的事故形态：消息表名是 msg_<md5(会话名)>，读取层一张都没命中时**以前静默返回空数组**，
 * 于是微信改版后群消息、待回复队列、议题分析、数字员工值班、发送闭环校验集体「0 条消息」，
 * 而界面和日志都说 ok。这里断言「这类情况必须报错」「正常的空会话不许报错（否则天天误报）」。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-msg-table-scan-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'scan.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/wechat/messageTableScan.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { messageTableHashOf, judgeMessageTableScan } = require(bundle)

  const h32 = 'a'.repeat(32)
  console.log('表名 → 会话 hash：')
  ok(messageTableHashOf('msg_' + h32) === h32, '标准 msg_<32hex> 命中')
  ok(messageTableHashOf('msg_' + 'A'.repeat(32)) === h32, '大写 hex 归一为小写（与旧实现一致）')
  ok(messageTableHashOf('Msg_' + h32) === h32, '前缀大小写不敏感（SQL 侧已用 lower(name) 筛过）')
  ok(messageTableHashOf('msg_' + 'a'.repeat(31)) === null, '31 位 → 命名不符')
  ok(messageTableHashOf('msg_' + 'a'.repeat(33)) === null, '33 位 → 命名不符')
  ok(messageTableHashOf('msg_' + 'z'.repeat(32)) === null, '非 hex → 命名不符')
  ok(messageTableHashOf('message_' + h32) === null, '前缀变了 → 命名不符（改版信号）')
  ok(messageTableHashOf('') === null && messageTableHashOf(undefined) === null, '空值安全')

  console.log('扫描结论（决定要不要报错）：')
  const v0 = judgeMessageTableScan({ openedDbs: 0, candidateTables: 0, hashedTables: 0, matchedTables: 0 })
  ok(v0.ok === false, '一个库都没打开 → 报错（不能静默空数组）')
  const v1 = judgeMessageTableScan({ openedDbs: 3, candidateTables: 0, hashedTables: 0, matchedTables: 0 })
  ok(v1.ok === false && v1.error.includes('未匹配到消息表'), '有库但一张 msg_<32hex> 都没有 → 报错（微信改版）')
  const v2 = judgeMessageTableScan({ openedDbs: 1, candidateTables: 40, hashedTables: 40, matchedTables: 0 })
  ok(v2.ok === true, '有消息表、只是这个会话没命中 → 不报错（可能确实还没消息）')
  const v3 = judgeMessageTableScan({ openedDbs: 2, candidateTables: 41, hashedTables: 41, matchedTables: 1 })
  ok(v3.ok === true, '正常命中 → 通过')
  const v4 = judgeMessageTableScan({ openedDbs: 1, candidateTables: 7, hashedTables: 0, matchedTables: 0 })
  ok(v4.ok === false && v4.error.includes('7'), '错误文案带上候选表数（便于排障）')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
