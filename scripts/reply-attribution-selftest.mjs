#!/usr/bin/env node
/**
 * 跟进判定「回复归属」回归自检(零依赖):
 *   node --experimental-strip-types scripts/reply-attribution-selftest.mjs
 *
 * 用例来自线上真实时间线(issue 82):客户连发三条 → 我方同事回复,
 * 旧规则在第二条客户消息处就判定「回合结束」,回复被漏掉,状态长期停在「待处理」。
 */
import {
  attributeStaffReplies,
  replyForAnchor,
  lastCustomerMessageAt
} from '../src/main/services/feedback/replyAttribution.ts'

const TEAM = new Set(['team_chen'])
/** 构造一条消息:msg(时间, 发送人, 内容标记) */
const cm = (at, username, opts = {}) => ({
  createTime: at,
  senderUsername: opts.isSend ? undefined : username,
  isSend: !!opts.isSend,
  localType: 1
})

let failed = 0
const log = (ok, name, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? ' — ' + detail : ''}`)
}

console.log('\n[1] 客户连发三条(含图片/追问)后同事回复 → 仍应判定「已回复」(回归 issue 82)')
{
  const msgs = [
    cm(1000, 'cust_a'),
    cm(1000, 'cust_a'),
    cm(1050, 'cust_a'),
    cm(1078, 'team_chen'),
    cm(1089, 'cust_a')
  ]
  const reps = attributeStaffReplies(msgs, TEAM)
  const hit = replyForAnchor(reps, 'cust_a', 1000)
  log(!!hit && hit.at === 1078 && hit.by === 'team_chen', 'attributed reply', JSON.stringify(hit))
}

console.log('\n[2] 群里另一位客户被回复,不能算成本议题的回复')
{
  const msgs = [cm(1000, 'cust_a'), cm(1010, 'cust_b'), cm(1020, 'team_chen')]
  const reps = attributeStaffReplies(msgs, TEAM)
  log(replyForAnchor(reps, 'cust_a', 1000) === null, 'cust_a 未回复', String(replyForAnchor(reps, 'cust_a', 1000)))
  log(replyForAnchor(reps, 'cust_b', 1010)?.at === 1020, 'cust_b 已回复')
}

console.log('\n[3] 锚点之前的回复不算这条议题的跟进')
{
  const msgs = [cm(500, 'cust_a'), cm(600, 'team_chen'), cm(1000, 'cust_a')]
  const reps = attributeStaffReplies(msgs, TEAM)
  log(replyForAnchor(reps, 'cust_a', 1000) === null, '旧回复被排除')
  log(replyForAnchor(reps, 'cust_a', 500)?.at === 600, '作为旧议题锚点则成立')
}

console.log('\n[4] 我本人回复同样归属(by 为空 = 我)')
{
  const msgs = [cm(1000, 'cust_a'), cm(1100, 'me', { isSend: true })]
  const reps = attributeStaffReplies(msgs, TEAM)
  const hit = replyForAnchor(reps, 'cust_a', 1000)
  log(!!hit && hit.at === 1100 && hit.by === undefined, 'self reply', JSON.stringify(hit))
}

console.log('\n[5] 静默收尾输入:客户在回复之后又发言 → 最后发言时间晚于回复')
{
  const msgs = [cm(1000, 'cust_a'), cm(1100, 'team_chen'), cm(1200, 'cust_a')]
  const reps = attributeStaffReplies(msgs, TEAM)
  const reply = replyForAnchor(reps, 'cust_a', 1000)
  const lastCust = lastCustomerMessageAt(msgs, 1000, 'cust_a')
  log(!!reply && lastCust === 1200 && lastCust > reply.at, '客户又发言', `lastCust=${lastCust} reply=${reply?.at}`)
}

console.log(failed === 0 ? '\n全部通过 ✅' : `\n${failed} 项未通过 ❌`)
process.exit(failed === 0 ? 0 : 1)
