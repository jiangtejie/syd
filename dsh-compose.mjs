import fs from 'fs'
const blocks = JSON.parse(fs.readFileSync('dsh-mod-blocks.json', 'utf8'))
const dir = 'src/main/services/feedback/'
const exportAll = (text) =>
  text
    .split('\n')
    .map((l) => (/^(?:async )?function |^const [A-Za-z_0-9]+(?:\s*:[^=]+)? =|^interface /.test(l) ? 'export ' + l : l))
    .join('\n')

const files = {
  'shared.ts': `/**
 * 群问题分析：消息/文本层公共基础（原 analyzer.ts 拆出）。
 * 这里只放**被两个以上阶段共用**的东西：消息→文本、发送人标签、回合内我方回复判定、
 * 证据合并、会话分段、以及跨库读取窗口。分析主流程见 analyzer.ts，各阶段见
 * ruleExtract / llmExtract / reconcile / duplicates。
 */
import * as wxService from '../wechat/wxService'
import type {
  ChatMessage,
  FeedbackIssueMsg,
  FeedbackIssueSeverity,
  FeedbackIssueType
} from '../../../shared/types'

${exportAll(blocks.shared)}
`,
  'ruleExtract.ts': `/**
 * 规则提取（LLM 不可用/失败时的兜底；也是「关键词聚类 + 末尾未回复」的唯一实现）。
 */
import type { NewIssue } from '../../db/repos/issueRepo'
import type { ChatMessage, FeedbackIssueSeverity, FeedbackIssueType } from '../../../shared/types'
import {
  hasStaffReplyAfter,
  isRuleText,
  msgToSummaryMsg,
  msgToText,
  normalizeSeverity,
  senderLabel
} from './shared'

${exportAll(blocks.ruleExtract)}
`,
  'llmExtract.ts': `/**
 * LLM 提取：分批消费主区、按段排版、证据行号回映射、议题级归一化。
 */
import { createAiProvider } from '../ai/provider'
import type { NewIssue } from '../../db/repos/issueRepo'
import type { ChatMessage } from '../../../shared/types'
import {
  LlmLineRef,
  LlmLineResolver,
  LlmRow,
  msgToSummaryMsg,
  normalizeSeverity,
  normalizeType,
  segmentizeLines
} from './shared'

${exportAll(blocks.llmExtract)}
`,
  'reconcile.ts': `/**
 * 规则型跟进/收尾判定（确定性）：跟进中 / 待处理 / 静默收尾 / 超期搁置。
 * 与 LLM 的分工：规则管「有没有人应过」，LLM 管「议题是否真的闭环」。
 */
import { getConfigNumber } from '../../db/repos/config'
import { listOpenIssuesByGroup, setIssueFollowUp, setIssueStatus } from '../../db/repos/issueRepo'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import type { ChatMessage } from '../../../shared/types'
import { INCR_TAIL_MS, readGroupMessages, staffReplyAt } from './shared'

${exportAll(blocks.reconcile)}
`,
  'duplicates.ts': `/**
 * 存量去重：把历史上因锚点漂移产生的重复议题合并回一条（人工预览 + 高置信自动）。
 */
import {
  applyIssueMerge,
  archiveDuplicates,
  getIssueMsgs,
  listIssues,
  openTopicIndex
} from '../../db/repos/issueRepo'
import type { FeedbackIssue, FeedbackIssueSeverity } from '../../../shared/types'
import { clusterTopics, TOPIC_TIME_NEAR_MS } from './issueSimilarity'
import { mergeEvidence, UNREPLIED_MERGE_MS } from './shared'

${exportAll(blocks.duplicates)}
`
}
for (const [name, content] of Object.entries(files)) {
  fs.writeFileSync(dir + name, content.replace(/\n{3,}/g, '\n\n'))
  console.log(name, content.split('\n').length)
}
fs.writeFileSync('dsh-keep.ts', blocks.__keep)
console.log('keep', blocks.__keep.split('\n').length)
