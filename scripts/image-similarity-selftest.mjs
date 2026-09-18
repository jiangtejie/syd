import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 「产物到底改没改」判据自检（纯函数）。
 *
 * 这条判据的两种错法都有代价：
 *  - 阈值太松：模型把原图原样回传（图生图没生效）时也放过去，用户以为爆改成功了，实际拿到别人的图；
 *  - 阈值太紧：正常改写（我们本来就要求保持构图）被误判成没生效，天天弹无效警告。
 * 所以两头都要钉：几乎一致 → 抓到；真实改动（构图保留但内容换了）→ 不报。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-img-sim-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

const flat = (v, n = 256) => Array.from({ length: n }, () => v)
const withBlock = (base = 40, block = 200) => {
  const a = flat(base)
  for (let i = 100; i < 130; i++) a[i] = block
  return a
}

try {
  const bundle = join(work, 'imageSimilarity.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/growth/ai/imageSimilarity.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const { meanAbsDiff, looksLikeEcho, ECHO_MAD_THRESHOLD, SIG_SIZE } = require(bundle)

  console.log('基本量：')
  ok(SIG_SIZE === 16, '签名边长 16（256 个采样点）', String(SIG_SIZE))
  ok(meanAbsDiff([10, 20], [10, 20]) === 0, '同一张图 MAD = 0')
  ok(meanAbsDiff([0, 0], [10, 10]) === 10, '差 10 的两张 MAD = 10', String(meanAbsDiff([0, 0], [10, 10])))
  ok(Number.isNaN(meanAbsDiff([], [])), '空输入返回 NaN（不假装算出 0）')

  console.log('判据两头：')
  ok(looksLikeEcho(withBlock(), withBlock()) === true, '几乎一致 → 判为疑似原图回传')
  ok(looksLikeEcho(withBlock(40, 200), withBlock(42, 203)) === true, '只差一点点（±2）仍判为疑似')
  ok(
    looksLikeEcho(withBlock(40, 200), withBlock(120, 60)) === false,
    '内容真的换了（明暗整体反转）→ 不报，避免天天误报'
  )
  ok(
    looksLikeEcho(withBlock(40, 200), withBlock(40, 200).map((v) => v + 30)) === false,
    '整体调色变化 30 → 不报'
  )
  ok(looksLikeEcho([], []) === false && looksLikeEcho([1], [1, 2]) === false, '取不到签名/长度不一致 → 不报警')
  ok(
    ECHO_MAD_THRESHOLD > 0 && ECHO_MAD_THRESHOLD < 10,
    '阈值落在合理区间（既不放过几乎一致，也不误伤正常改写）',
    String(ECHO_MAD_THRESHOLD)
  )
  ok(looksLikeEcho(flat(0), flat(ECHO_MAD_THRESHOLD + 1)) === false, '刚好超过阈值就不报（边界）')
  ok(looksLikeEcho(flat(0), flat(ECHO_MAD_THRESHOLD - 1)) === true, '刚好低于阈值就报（边界）')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
