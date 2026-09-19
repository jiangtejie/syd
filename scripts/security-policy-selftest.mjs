import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 落盘数据治理的两个纯判定自检。
 *
 * 钉住的事故形态：
 *  ① 图片解密密钥（img:<wxid>:xorKey/aesKey）**不在固定敏感键名单里**，于是长期明文落库 ——
 *     而它键名带账号、事前列不全，只能按前缀认；
 *  ② 注入截图目录里除了截图还有 `wx-phase.txt`（注入状态标记），它是「状态未知绝不自动重试」
 *     的判据，**误删会导致重复发送**；清理逻辑必须只碰截图。
 */

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-security-policy-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'securityPolicy.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/securityPolicy.ts')],
    bundle: true, platform: 'node', format: 'cjs', outfile: bundle
  })
  const { isSecretConfigKey, isInjectShot, shouldPruneInjectShot } = require(bundle)

  console.log('哪些配置键属于敏感值（落库前必须加封）：')
  // growth.providerApiKey / growth.search.apiKey 所属链路已下线，但键名仍留在名单里：
  // 老库可能还躺着明文，留在名单里才保证「读出来加封、不回传渲染层」。
  const SECRET_KEYS = [
    'ai.apiKey',
    'growth.image.apiKey',
    'growth.providerApiKey',
    'growth.search.apiKey',
    'lark.appSecret'
  ]
  for (const k of SECRET_KEYS) {
    ok(isSecretConfigKey(k) === true, '固定名单：' + k)
  }
  ok(
    SECRET_KEYS.includes('growth.providerApiKey') && SECRET_KEYS.includes('growth.search.apiKey'),
    '已下线链路的旧 Key 仍在名单（历史明文不能漏在名单外）'
  )
  ok(isSecretConfigKey('img:wxid_abc123:xorKey') === true, '★ 图片 XOR 密钥（键名带账号，此前认不出来）')
  ok(isSecretConfigKey('img:wxid_abc123:aesKey') === true, '★ 图片 AES 密钥')
  ok(isSecretConfigKey('img:someone-else:anyField') === true, '前缀匹配：账号换了也认得出')
  ok(isSecretConfigKey('  ai.apiKey  ') === true, '两侧空白不影响判断')
  for (const k of ['send.halted', 'ai.baseUrl', 'ai.model', 'imageKeys', 'img', '', '   ']) {
    ok(isSecretConfigKey(k) === false, '不是敏感键：' + JSON.stringify(k))
  }
  ok(isSecretConfigKey('ximg:foo:xorKey') === false, '前缀必须从头匹配（img: 不是 img 结尾）')

  console.log('哪些文件算注入截图：')
  ok(isInjectShot('wx-before-enter.png') === true, '正常截图')
  ok(isInjectShot('wx-last-opened.png') === true, '另一张正常截图')
  ok(isInjectShot('WX-AFTER-CLICK.PNG') === true, '大小写不敏感')
  ok(isInjectShot('wx-phase.txt') === false, '★ 状态标记不是截图（删了会让「状态未知」判定失效 → 重复发送）')
  ok(isInjectShot('wx-notes.md') === false, '同前缀但不是 png')
  ok(isInjectShot('other.png') === false, '别的 png 不归我们管')
  ok(isInjectShot('') === false, '空名安全')

  console.log('清理判据：')
  const day = 86_400_000
  const shot = (over) => Object.assign({ name: 'wx-a.png', ageMs: 0, keepDays: 3, index: 0, keepFiles: 20 }, over)
  ok(shouldPruneInjectShot(shot({ ageMs: 4 * day })) === true, '超过保留天数 → 删')
  ok(shouldPruneInjectShot(shot({ ageMs: 2 * day })) === false, '没超期 → 留')
  ok(shouldPruneInjectShot(shot({ ageMs: 3 * day })) === false, '正好等于保留期 → 留（边界按「超过」才删）')
  ok(shouldPruneInjectShot(shot({ ageMs: 999 * day, keepDays: 0 })) === false, 'keepDays=0 表示不按时间清')
  ok(shouldPruneInjectShot(shot({ index: 20, keepFiles: 20 })) === true, '数量超出上限 → 删最旧的')
  ok(shouldPruneInjectShot(shot({ index: 19, keepFiles: 20 })) === false, '上限之内 → 留')
  ok(shouldPruneInjectShot(shot({ index: 999, keepFiles: 0 })) === false, 'keepFiles=0 表示不按数量清')
  ok(shouldPruneInjectShot(shot({ keepDays: 0, keepFiles: 0 })) === false, '两个都关 → 一律不删')
  ok(shouldPruneInjectShot(shot({ name: 'wx-phase.txt', ageMs: 999 * day })) === false, '★ 非截图永不删')
  ok(shouldPruneInjectShot(shot({ name: 'wx-phase.txt', index: 999 })) === false, '★ 非截图连数量上限也不适用')
} finally {
  try { rmSync(work, { recursive: true, force: true }) } catch { /* Windows 偶发占用 */ }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
