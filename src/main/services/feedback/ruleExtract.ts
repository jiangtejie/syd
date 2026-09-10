/**
 * 规则提取（LLM 不可用/失败时的兜底；也是「关键词聚类 + 末尾未回复」的唯一实现）。
 */
import type { NewIssue } from '../../db/repos/issueRepo'
import type { ChatMessage, FeedbackIssueSeverity, FeedbackIssueType } from '../../../shared/types'
import { attributeStaffReplies, replyForAnchor } from './replyAttribution'
import { isRuleText, isTeamMsg, msgToSummaryMsg, msgToText, senderLabel } from './shared'

/** 本地兜底规则：命中即归类，文本仅在客户消息上匹配 */
export const RULE_KEYWORDS: Array<{ type: FeedbackIssueType; keywords: string[] }> = [
  {
    type: '客诉',
    keywords: ['投诉', '差评', '垃圾', '太差', '翻车', '气死', '失望', '再也不买', '质量问题']
  },
  {
    type: '售后',
    keywords: ['退货', '退款', '换货', '维修', '质保', '保修', '三包', '售后']
  },
  {
    type: '物流',
    keywords: ['快递', '物流', '发货', '配送', '签收', '没到', '包裹', '运单', '迟迟不发', '截单']
  },
  {
    type: '价格',
    keywords: ['太贵', '价格', '优惠', '折扣', '差价', '涨价', '优惠券', '划算吗', '便宜点']
  },
  {
    type: '建议',
    keywords: ['建议', '希望', '能不能加', '期待', '优化', '要是能']
  },
  {
    type: '咨询',
    keywords: [
      '请问',
      '怎么',
      '如何',
      '可以吗',
      '什么时候',
      '多少钱',
      '在哪',
      '能用吗',
      '有没有',
      '支持吗'
    ]
  }
]

/** 规则严重度基线：客诉/售后/物流默认 高，其余 一般 */
export const RULE_SEV_BASE: Record<FeedbackIssueType, FeedbackIssueSeverity> = {
  客诉: '高',
  售后: '高',
  物流: '高',
  价格: '一般',
  咨询: '一般',
  建议: '一般',
  其他: '一般'
}

/** 规则情绪升级词：客户文本命中的任一即升 紧急（客服优先介入） */
export const RULE_SEV_BOOST = [
  '马上',
  '立刻',
  '气死',
  '曝光',
  '12315',
  '投诉到',
  '退钱',
  '赔',
  '急',
  '现在就要',
  '必须处理',
  '再也不买'
]

/** 规则议题聚类窗：同一客户同一类型诉求间隔 ≤ 该值视为同一议题的多句跟进 */
export const RULE_CLUSTER_MS = 60 * 60_000

/** 规则单议题证据消息上限 */
export const RULE_EVIDENCE_CAP = 8

/**
 * 本地规则提取（议题级）：
 * 1) 关键词命中按「同一客户 + 同一类型 + 60 分钟窗」聚成议题（一次抱怨的多句/追问只建一条问题）；
 * 2) followUp=客服/团队在议题期间介入过但未闭环（不再简单跳过）；无介入=未处理；
 * 3) 末尾「客户留言无回复」兜底（与关键词议题去重）。
 */
export function ruleExtract(msgs: ChatMessage[], team: Set<string>): NewIssue[] {
  interface RuleHit {
    i: number
    m: ChatMessage
    type: string
  }
  // 归属表：每条我方/团队消息归属给最近一条客户消息的发送人（与 reconcile 同一套判定）
  const replies = attributeStaffReplies(msgs, team)
  const hits: RuleHit[] = []
  for (let i = 0; i < msgs.length; i++) {
    const m = msgs[i]
    const u = m.senderUsername
    if (m.isSend || (u && team.has(u)) || !isRuleText(m)) continue
    const text = msgToText(m)
    const rule = RULE_KEYWORDS.find((r) => r.keywords.some((k) => text.includes(k)))
    if (!rule) continue
    hits.push({ i, m, type: rule.type })
  }
  // 聚类：同人同类型、与前一条命中间隔 ≤ 窗 → 同一议题
  const clusters: RuleHit[][] = []
  for (const h of hits) {
    const cur = clusters[clusters.length - 1]
    if (
      cur &&
      cur[0].m.senderUsername === h.m.senderUsername &&
      cur[0].type === h.type &&
      h.m.createTime - cur[cur.length - 1].m.createTime <= RULE_CLUSTER_MS
    ) {
      cur.push(h)
      continue
    }
    clusters.push([h])
  }

  const issues: NewIssue[] = []
  const clusterAnchorTimes = new Set<number>()
  for (const c of clusters) {
    const first = c[0].m
    const label = senderLabel(first, team)
    const text0 = msgToText(first)
    // 议题内我方/团队有过归属回复 → 跟进中（客户连发多条后再回复也算）
    const firstSender = first.isSend ? undefined : (first.senderUsername ?? undefined)
    const replied = replyForAnchor(replies, firstSender, first.createTime) !== null
    const evidMsgs = c.map((h) => h.m).slice(-RULE_EVIDENCE_CAP)
    const n = c.length
    const title =
      n > 1 ? `${label}：${text0.slice(0, 16)}…（共 ${n} 句）` : `${label}：${text0.slice(0, 24)}`
    const summary =
      n > 1
        ? evidMsgs
            .map((mm) => msgToText(mm))
            .join(' ｜ ')
            .slice(0, 90)
        : text0.slice(0, 80)
    for (const h of c) clusterAnchorTimes.add(h.m.createTime)
    const sevText = c.map((h) => msgToText(h.m)).join(' ')
    const severity: FeedbackIssueSeverity = RULE_SEV_BOOST.some((w) => sevText.includes(w))
      ? '紧急'
      : RULE_SEV_BASE[c[0].type as FeedbackIssueType]
    // 弱命中疑似桶：单句 + 咨询类 + 短文本 + 客服未介入 → 疑似待人工确认（不进正式待办口径）
    const weakConfirm = c.length === 1 && c[0].type === '咨询' && text0.length <= 14 && !replied
    const customerNames = [label].filter((x) => !x.startsWith('我方'))
    issues.push({
      key: `${c[0].type}|${first.createTime}|${first.localId}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: c[0].type as FeedbackIssueType,
      title,
      summary,
      occurAt: first.createTime,
      method: 'rule',
      severity,
      needConfirm: weakConfirm,
      customers: customerNames,
      followUp: replied,
      msgs: evidMsgs.map((mm) => msgToSummaryMsg(mm, senderLabel(mm, team), isTeamMsg(mm, team)))
    })
  }

  // 末尾「客户留言无回复」：窗内最后一条客户真文本消息，不属于任何关键词议题，且仍无我方/团队回复
  let tailIdx = -1
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    const u = m.senderUsername
    if (!m.isSend && !(u && team.has(u)) && isRuleText(m)) {
      tailIdx = i
      break
    }
  }
  const tail = tailIdx >= 0 ? msgs[tailIdx] : undefined
  if (
    tail &&
    !clusterAnchorTimes.has(tail.createTime) &&
    replyForAnchor(replies, tail.senderUsername ?? undefined, tail.createTime) === null
  ) {
    issues.push({
      key: `unreplied:${tail.createTime}`,
      wxid: '',
      groupUsername: '',
      groupName: '',
      type: '咨询',
      title: `${senderLabel(tail, team)}：${msgToText(tail).slice(0, 24)}`,
      summary: '客户留言后未见客服（或团队）回复',
      occurAt: tail.createTime,
      method: 'rule',
      severity: '一般',
      customers: [senderLabel(tail, team)].filter((x) => !x.startsWith('我方')),
      msgs: [msgToSummaryMsg(tail, senderLabel(tail, team), isTeamMsg(tail, team))]
    })
  }
  return issues
}
