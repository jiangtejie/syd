/**
 * 老库形状 vs 当前代码形状 的列对比：找出「代码已经不写、但老库里还是 NOT NULL 无默认」的列。
 * 这类列会让当前 INSERT 直接撞 NOT NULL constraint failed —— growth_remix_output.job_id 就是这么炸的。
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const dbFile = process.argv[2]
const schemaDir = process.argv[3]

/** 从一段 CREATE TABLE 文本里取列名 + 是否 NOT NULL 无默认 */
function colsOf(body) {
  const out = []
  for (const raw of body.split(',')) {
    const line = raw.trim()
    const m = line.match(/^([a-z_][a-z0-9_]*)\s+([A-Za-z]+)/)
    if (!m) continue
    if (/^(PRIMARY|FOREIGN|UNIQUE|CHECK|CONSTRAINT)$/i.test(m[1])) continue
    out.push({ name: m[1], notNullNoDefault: /NOT NULL/i.test(line) && !/DEFAULT/i.test(line) })
  }
  return out
}

function parseDdls(text) {
  const map = new Map()
  const re = /CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(/g
  let m
  while ((m = re.exec(text))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < text.length; i++) {
      if (text[i] === '(') depth++
      else if (text[i] === ')') { depth--; if (depth === 0) break }
    }
    const body = text.slice(m.index + m[0].length, i)
    if (!map.has(m[1])) map.set(m[1], colsOf(body))
  }
  return map
}

const legacy = parseDdls(readFileSync(dbFile).toString('latin1'))

let current = ''
for (const f of readdirSync(schemaDir)) {
  if (!f.endsWith('.ts')) continue
  current += readFileSync(join(schemaDir, f), 'utf8')
}
const cur = parseDdls(current)

// columns.ts 的 ensureColumn 会补列，也算「当前形状有」
const added = new Map()
for (const m of current.matchAll(/table: '([a-z_]+)',\s*\n\s*column: '([a-z_]+)'/g)) {
  if (!added.has(m[1])) added.set(m[1], [])
  added.get(m[1]).push(m[2])
}

const problems = []
for (const [table, lcols] of legacy) {
  const ccols = cur.get(table)
  if (!ccols) {
    problems.push({ table, kind: '表已从代码删除', detail: lcols.map((c) => c.name).join(',') })
    continue
  }
  const curNames = new Set([...ccols.map((c) => c.name), ...(added.get(table) ?? [])])
  for (const c of lcols) {
    if (curNames.has(c.name)) continue
    problems.push({
      table,
      kind: c.notNullNoDefault ? '★ 老库 NOT NULL 无默认，代码不再写入' : '老库多一列（可空/有默认，无害）',
      detail: c.name
    })
  }
}
for (const p of problems) console.log(p.kind + '  ' + p.table + '.' + p.detail)
console.log('legacy tables=' + String(legacy.size) + ' code tables=' + String(cur.size))
