/**
 * 只改「预览产物里的 mock 副本」(out-preview/renderer/mock.js)：
 * 把营销 AI 工作台的对话桩换成带 Markdown/思考/引用/Token 的富内容，
 * 用来目视验证「营销工作台和 AI 工作台同一套渲染」。源码 mock.js 不动。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const p = process.argv[2]
let s = readFileSync(p, 'utf8')
const re = /\{ id: 6, role: 'assistant', kind: 'text', content: '[^']*', createdAt: now - 3 \* MIN \}/
if (!re.test(s)) {
  console.error('ANCHOR_NOT_FOUND')
  process.exit(2)
}

const md = [
  '## 已改好的 3 条标题候选',
  '',
  '按「人均 68 / 鲜切黄牛肉」重排了卖点顺序，**第一条走性价比**，第三条留给到店理由：',
  '',
  '| 候选 | 主打卖点 | 预估点击 |',
  '| --- | --- | --- |',
  '| 1 | 人均 68 吃到扶墙 | 高 |',
  '| 2 | 鲜切黄牛肉 8 秒出锅 | 中 |',
  '| 3 | 开了 12 年的社区店 | 中 |',
  '',
  '- [x] 标题去掉了绝对化用语「最」',
  '- [ ] 正文还差一段到店路线',
  '',
  '> [!WARNING]',
  '> 「第一」属于绝对化用语，合规校验会拦；建议改成「本地人常去」。',
  '',
  '正文里的价格写成 \`68 元/人\` 更稳，参考 [平台规范](https://example.com/rule)。',
  '',
  '---',
  '',
  '![封面候选](ct-growth://media/demo/gen-1.jpg)'
].join('\n')

const md2 = [
  '短视频脚本前 3 秒（钩子）：',
  '',
  '\`\`\`text',
  '0-3s  锅里翻滚的特写 + 字幕「人均 68」',
  '3-8s  鲜切黄牛肉下锅，8 秒出锅',
  '\`\`\`',
  '',
  '1. 先给结果，再讲为什么',
  '2. 结尾留一句到店理由'
].join('\n')

const metaObj = JSON.stringify({
  reasoning:
    '先核对门店事实：人均 68、鲜切黄牛肉、12 年老店都在品牌档案里；再按平台规范剔除绝对化用语，最后按点击率把卖点前置。',
  reasoningMs: 8400,
  tokens: { input: 1860, output: 412 },
  evidence: [
    { n: 1, tool: 'growth_read_material', line: '人均 68 吃到扶墙｜12 年社区火锅，鲜切黄牛肉是招牌' },
    { n: 2, tool: 'growth_rewrite_title', line: '候选 3 条：性价比 / 单品 / 老店口碑' }
  ]
})

const rows = [
  "{ id: 6, role: 'assistant', kind: 'text', content: " + JSON.stringify(md) + ", meta: " + JSON.stringify(metaObj) + ", createdAt: now - 3 * MIN }",
  "{ id: 7, role: 'user', kind: 'text', content: '短视频脚本按这个思路写一版，前 3 秒要抓人', createdAt: now - 2 * MIN }",
  "{ id: 8, role: 'assistant', kind: 'text', content: " + JSON.stringify(md2) + ", meta: { tokens: { input: 2100, output: 260 } }, createdAt: now - 1 * MIN }"
].join(',\n    ')

s = s.replace(re, rows)
writeFileSync(p, s, 'utf8')
console.log('patched preview mock (rich chat rows)')
