#!/usr/bin/env node
/**
 * 日报文案自检（纯函数，零依赖不联网）：
 *   node --experimental-strip-types scripts/digest-selftest.mjs
 *
 * 日报是唯一「每天主动出现在管理层眼前」的东西，数字口径错了没人会去核对 —— 所以在这里钉死：
 * 等待时长换行、空口径不出现、空日报也要发得出一句话、条数与顺序稳定。
 */
import { ageText, renderDigest } from '../src/main/services/feedback/digestText.ts'

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n[1] 等待时长文案')
log(ageText(0) === '0分钟', '0 → 0分钟', ageText(0))
log(ageText(18 * 60_000) === '18分钟', '18 分钟', ageText(18 * 60_000))
log(ageText(60 * 60_000) === '1小时', '整点不带分钟', ageText(60 * 60_000))
log(ageText(5 * 3600_000 + 20 * 60_000) === '5小时20分', '小时+分钟', ageText(5 * 3600_000 + 20 * 60_000))
log(ageText(26 * 3600_000) === '1天2小时', '跨天', ageText(26 * 3600_000))
log(ageText(48 * 3600_000) === '2天', '整两天', ageText(48 * 3600_000))
log(ageText(-1000) === '0分钟', '负数兜底为 0')

const base = {
  dateLabel: '09-12',
  created: 3,
  resolved: 5,
  open: 12,
  noReply: 4,
  following: 6,
  overdue: 2,
  doubt: 1,
  topBacklog: [
    { group: '保利星荟店对接群', type: '物流', title: '孜然粉到货', ageText: '2天3小时', assignee: '陈西西' },
    { group: '南部店物配对接群', type: '售后', title: '鸡爪到不了', ageText: '1天5小时' }
  ],
  waiting: [{ group: '南部店物配对接群', type: '售后', title: '鸡爪到不了', ageText: '1天5小时' }],
  topAssignees: [
    { name: '陈西西', open: 4 },
    { name: '黄巧', open: 2 }
  ],
  agent: { total: 20, script: 12, llm: 5, handoff: 3, coverage: 0.6 }
}

console.log('\n[2] 完整日报')
const text = renderDigest(base)
const lines = text.split('\n')
log(lines[0] === '📋 群问题日报 · 09-12', '标题带日期', lines[0])
log(/新增 3 · 已解决 5 · 待处理 12/.test(text), '第一行含新增/已解决/待处理')
log(text.includes('其中无人应 4'), '含无人应')
log(text.includes('跟进超时 2'), '含跟进超时')
log(text.includes('疑似 1'), '含疑似')
log(text.includes('⏰ 积压最久') && text.includes('1. [保利星荟店对接群] 物流·孜然粉到货（等了 2天3小时） · 跟进:陈西西'), '积压条目格式与跟进人')
log(text.includes('🙋 无人应（客户在等）'), '无人应小节')
log(text.includes('👤 在手量：陈西西 4 · 黄巧 2'), '在手量一行')
log(text.includes('🤖 数字员工（影子）') && text.includes('话术覆盖 60%'), '数字员工统计与覆盖率取整', '')
log(lines.length <= 22, `整体不超过 22 行（手机可读）`, String(lines.length))
log(!text.includes('undefined'), '不出现 undefined')

console.log('\n[3] 空口径不出现 / 空日报也要发')
const quiet = renderDigest({
  ...base,
  created: 0,
  resolved: 0,
  open: 0,
  noReply: 0,
  following: 0,
  overdue: 0,
  doubt: 0,
  topBacklog: [],
  waiting: [],
  topAssignees: [],
  agent: null
})
log(!quiet.includes('其中无人应'), '无人应 0 → 不出现')
log(!quiet.includes('跟进超时'), '超时 0 → 不出现')
log(!quiet.includes('⏰'), '没有积压 → 不出小节')
log(!quiet.includes('🤖'), '没有数字员工数据 → 不出小节')
log(quiet.includes('今天没有待处理问题 ✓'), '全空时给一句「今天没问题」（证明任务还活着）')

console.log('\n[4] 极端值')
const one = renderDigest({ ...base, agent: { total: 3, script: 0, llm: 3, handoff: 0, coverage: 0 } })
log(one.includes('话术覆盖 0%'), '覆盖率 0% 正常显示')
const neg = renderDigest({ ...base, created: -1 })
log(neg.includes('新增 -1'), '异常数字原样透出（便于发现统计 bug，不静默吞掉）')

console.log('\n[5] 稳定性')
log(renderDigest(base) === renderDigest(base), '同输入同输出（无随机/无时间依赖）')

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
