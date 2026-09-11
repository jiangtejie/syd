#!/usr/bin/env node
/**
 * 媒体缓存淘汰策略的自检（纯 Node + 离线）：
 *   node scripts/media-cache-selftest.mjs
 *
 * 这条策略有个「删错就是用户数据丢失」的分界线：media 目录里混着可再生的解密产物、
 * 已无人读取的遗留命名、以及 PG media_path 指着的上报归档。这里把分界线固化成断言。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildSync } from 'esbuild'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const bundleDir = mkdtempSync(join(tmpdir(), 'dsh-media-cache-'))
const bundle = join(bundleDir, 'mediaCachePolicy.cjs')
buildSync({
  entryPoints: [join(root, 'src/main/services/media/mediaCachePolicy.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  outfile: bundle
})
const { classifyMediaCacheFile, planMediaPrune } = require(bundle)

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

const MD5 = 'a'.repeat(32)
const DAY = 24 * 3600_000
const NOW = Date.UTC(2026, 0, 1)

// 1) 分类：只有「可再生」的才会被删
{
  const cases = [
    [`${MD5}_orig.jpg`, 'asset'],
    [`${MD5}_thumb.jpg`, 'asset'],
    [`${MD5}_hd.png`, 'asset'],
    [`${MD5}_video.mp4`, 'asset'],
    [`${MD5}_emoji.gif`, 'asset'],
    [`${MD5}.gif`, 'legacy'],
    [`${MD5}_file.pdf`, 'archive'],
    ['报价单-2026.xlsx', 'other'],
    ['客服话术.docx', 'other'],
    ['README', 'other'],
    ['', 'other']
  ]
  for (const [name, want] of cases) {
    const got = classifyMediaCacheFile(name)
    log(got === want, `分类 ${name || '(空)'} → ${want}`, got === want ? undefined : `实际 ${got}`)
  }
}

// 2) 年龄是软上限：早于保留期的可再生文件回收，归档与不认识的一律不动
{
  const entries = [
    { name: `${MD5}_orig.jpg`, size: 100, mtimeMs: NOW - 200 * DAY }, // 老，可删
    { name: `${MD5}.gif`, size: 50, mtimeMs: NOW - 400 * DAY }, // 老 + 遗留，可删
    { name: `${MD5}_file.pdf`, size: 900, mtimeMs: NOW - 400 * DAY }, // 归档：不删
    { name: '报价单.xlsx', size: 800, mtimeMs: NOW - 400 * DAY }, // 不认识：不删
    { name: `${MD5}_video.mp4`, size: 200, mtimeMs: NOW - 10 * DAY } // 新：保留
  ]
  const plan = planMediaPrune(entries, { keepDays: 180, maxBytes: 0, maxFiles: 0, now: NOW })
  const removed = new Set(plan.remove)
  log(removed.has(`${MD5}_orig.jpg`), '超过保留期的解密产物被回收')
  log(removed.has(`${MD5}.gif`), '超过保留期的遗留命名被回收')
  log(!removed.has(`${MD5}_file.pdf`), '上报归档**永不**被回收')
  log(!removed.has('报价单.xlsx'), '不认识的命名（可能是无 md5 的归档）不被动')
  log(!removed.has(`${MD5}_video.mp4`), '未到保留期的文件保留')
  log(plan.keptProtected === 2, '受保护文件计数正确', String(plan.keptProtected))
  log(plan.freedBytes === 150, '回收字节数正确', String(plan.freedBytes))
}

// 3) keepDays=0 表示不按年龄删（只按容量兜底）
{
  const entries = [{ name: `${MD5}_orig.jpg`, size: 100, mtimeMs: NOW - 999 * DAY }]
  const plan = planMediaPrune(entries, { keepDays: 0, maxBytes: 0, maxFiles: 0, now: NOW })
  log(plan.remove.length === 0, 'keepDays=0 → 不按年龄删除')
}

// 4) 容量是硬上限：年龄之外仍超限就按最旧削，且不动受保护文件
{
  const entries = [
    { name: `${MD5}_orig.jpg`, size: 400, mtimeMs: NOW - 1 * DAY },
    { name: `${MD5}_video.mp4`, size: 400, mtimeMs: NOW - 2 * DAY },
    { name: `${MD5}_emoji.gif`, size: 400, mtimeMs: NOW - 3 * DAY },
    { name: `${MD5}_file.pdf`, size: 5000, mtimeMs: NOW - 5 * DAY }
  ]
  const plan = planMediaPrune(entries, {
    keepDays: 180,
    maxBytes: 1000 * 1024,
    maxFiles: 2,
    now: NOW
  })
  const removed = new Set(plan.remove)
  log(!removed.has(`${MD5}_file.pdf`), '容量超限时也不动归档（不会为省空间丢用户数据）')
  log(removed.has(`${MD5}_emoji.gif`), '按最旧削到文件数上限内（最旧的先走）')
  log(!removed.has(`${MD5}_orig.jpg`), '削到上限即停（不会一路删光）')
  log(plan.trimmedBySize === 1, '统计「超容量被削」的数量', String(plan.trimmedBySize))
  log(plan.keptProtected === 1, '归档不计入可回收额度', String(plan.keptProtected))

  // 字节上限同样只算可回收部分
  const big = planMediaPrune(
    [
      { name: `${MD5}_orig.jpg`, size: 800, mtimeMs: NOW - 3 * DAY },
      { name: `${MD5}_video.mp4`, size: 800, mtimeMs: NOW - 1 * DAY },
      { name: `${MD5}_file.pdf`, size: 100000, mtimeMs: NOW }
    ],
    { keepDays: 180, maxBytes: 1000, maxFiles: 0, now: NOW }
  )
  log(
    big.remove.length === 1 && big.remove[0] === `${MD5}_orig.jpg`,
    '字节上限只按可回收部分计算（最旧的先削，削够即停）',
    JSON.stringify(big)
  )
}

// 5) 容量统计把受保护文件算进去（否则每次都会误判为超限）
{
  const entries = [
    { name: `${MD5}_file.pdf`, size: 10 * 1024 * 1024, mtimeMs: NOW },
    { name: `${MD5}_orig.jpg`, size: 100, mtimeMs: NOW }
  ]
  const plan = planMediaPrune(entries, { keepDays: 180, maxBytes: 1024, maxFiles: 1, now: NOW })
  log(plan.remove.length === 0, '归档占满容量时不误删可再生文件以外的东西', JSON.stringify(plan))
}

rmSync(bundleDir, { recursive: true, force: true })
console.log(`\n${failed === 0 ? '全部通过' : failed + ' 项失败'}`)
process.exit(failed === 0 ? 0 : 1)
