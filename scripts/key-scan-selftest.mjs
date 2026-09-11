#!/usr/bin/env node
/**
 * 密钥获取纯逻辑自检（离线）：
 *   node scripts/key-scan-selftest.mjs
 *
 * 自动获取密钥的**唯一安全边界**是「候选必须通过真实库的页 1 HMAC 校验」，所以这里盯的是上游解析：
 * 从任意文本里挑候选（不能把半截/超长的十六进制当成 key）、拆命令行（引号/占位符）、路径列表解析。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-keyscan-'))
const bundle = join(bundleDir, 'keyScanPure.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/services/wechat/keyScanPure.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle
})
const {
  extractKeyCandidates,
  splitArgs,
  expandPlaceholders,
  parsePathList,
  needsCmdShim,
  quoteWinArg,
  buildCmdLine,
  MAX_KEY_CANDIDATES
} = require(bundle)

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const KEY = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90'
const KEY2 = '0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0'

// 1) 候选提取
{
  log(extractKeyCandidates(KEY)[0] === KEY, '裸 64 位十六进制被识别')
  log(extractKeyCandidates(`0x${KEY.toUpperCase()}`)[0] === KEY, '0x 前缀 + 大写被识别并归一化小写')
  const spaced = KEY.replace(/(..)/g, '$1 ').trim()
  log(extractKeyCandidates(spaced)[0] === KEY, '用空格分组的 64 位十六进制被识别')
  const coloned = KEY.replace(/(..)/g, '$1:').slice(0, -1)
  log(extractKeyCandidates(coloned)[0] === KEY, '用冒号分隔的 64 位十六进制被识别')
  log(extractKeyCandidates(`{"key":"${KEY}"}`)[0] === KEY, 'JSON 里能挑出来')
  log(extractKeyCandidates(`wxdb-key = ${KEY}\n[INFO] done`)[0] === KEY, '日志文本里能挑出来')

  log(extractKeyCandidates(KEY.slice(0, 63)).length === 0, '少一位的十六进制不当候选')
  log(extractKeyCandidates(KEY + 'ab').length === 0, '多两位的十六进制不当候选')
  log(extractKeyCandidates('deadbeef'.repeat(8)).length === 1, '刚好 64 位仍算候选（是否可用交给 HMAC 校验）')
  log(extractKeyCandidates(`${KEY}\n${KEY}`).length === 1, '重复出现只留一个')

  const many = Array.from({ length: 40 }, (_, i) =>
    (i.toString(16).padStart(2, '0')).repeat(32)
  ).join('\n')
  log(
    extractKeyCandidates(many).length === MAX_KEY_CANDIDATES,
    `候选数量被限流到 ${MAX_KEY_CANDIDATES}（每个都要跑 PBKDF2 校验）`,
    String(extractKeyCandidates(many).length)
  )
  log(extractKeyCandidates('') .length === 0, '空文本不炸')
}

// 2) 命令行拆解（不走 shell，但要支持带空格的引号参数）
{
  log(
    JSON.stringify(splitArgs('--wxid abc --db "C:/Program Files/WeChat"')) ===
      JSON.stringify(['--wxid', 'abc', '--db', 'C:/Program Files/WeChat']),
    '双引号包住的带空格参数算一个'
  )
  log(JSON.stringify(splitArgs("--out 'a b.txt'")) === JSON.stringify(['--out', 'a b.txt']), '单引号同样有效')
  log(JSON.stringify(splitArgs('  a   b  ')) === JSON.stringify(['a', 'b']), '多余空白被吃掉')
  log(JSON.stringify(splitArgs('a\\"b')) === JSON.stringify(['a"b']), '反斜杠转义引号')
  log(JSON.stringify(splitArgs('')) === JSON.stringify([]), '空参数串返回空数组')
  log(
    JSON.stringify(splitArgs('--p "unclosed arg')) === JSON.stringify(['--p', 'unclosed arg']),
    '未闭合引号按到结尾处理（不丢参数）'
  )
}

// 3) 占位符与路径列表
{
  const vars = { wxid: 'wxid_x', dbPath: 'C:/wx', dbStorage: 'C:/wx/db_storage' }
  log(
    expandPlaceholders('--wxid {{wxid}} --dir "{{dbStorage}}"', vars) ===
      '--wxid wxid_x --dir "C:/wx/db_storage"',
    '占位符替换（含大小写不敏感与空格）'
  )
  log(expandPlaceholders('--x {{ dbPath }}', vars) === '--x C:/wx', '占位符内允许空格')
  log(expandPlaceholders('no placeholder', vars) === 'no placeholder', '没有占位符时原样返回')
  const paths = parsePathList('C:/a;D:\\b\nC:/c|C:/d')
  log(JSON.stringify(paths) === JSON.stringify(['C:/a', 'D:\\b', 'C:/c', 'C:/d']), '路径列表支持 ; 换行 |')
  log(parsePathList('') .length === 0, '空路径列表返回空数组')
}

// 4) .cmd/.bat 包装器（实测：execFile 直接跑 .cmd 会 spawn EINVAL，必须走 cmd.exe）
{
  log(needsCmdShim('C:/tools/dump-key.cmd'), '.cmd 被识别为需要 cmd 包装')
  log(needsCmdShim('C:\\tools\\dump.bat'), '.bat 同理（大小写无关）', String(needsCmdShim('C:\\tools\\DUMP.BAT')))
  log(!needsCmdShim('C:/tools/dump-key.exe'), '可执行文件不需要包装')

  log(quoteWinArg('plain') === 'plain', '无空白/特殊字符的参数不加引号')
  log(quoteWinArg('C:/a b/c.exe') === `"C:/a b/c.exe"`, '带空格加引号')
  log(quoteWinArg('') === '""', '空参数转成一对引号（不掉参数）')
  const withQuote = quoteWinArg('say "hi"')
  log(withQuote.startsWith('"') && withQuote.endsWith('"') && withQuote.includes('\\"'), '参数内引号按 Windows 规则转义', withQuote)
  log(quoteWinArg('a&b') === `"a&b"`, 'shell 元字符一律加引号（cmd 模式下的注入面收窄）')

  const line = buildCmdLine('C:/tools/dump key.cmd', ['--wxid', 'wxid_x', '--out', 'C:/a b.txt'])
  log(
    line === `"C:/tools/dump key.cmd" --wxid wxid_x --out "C:/a b.txt"`,
    'cmd 命令行拼接正确',
    line
  )
  log(!line.includes('undefined') && !line.includes('null'), '拼接不会漏出 undefined/null')
}

void KEY2
rmSync(bundleDir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
