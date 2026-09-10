import fs from 'fs'
const keep = fs.readFileSync('dsh-keep.ts', 'utf8')
const header = `import * as wxService from '../wechat/wxService'
import { createAiProvider } from '../ai/provider'
import { getTeamUsernamesCached } from '../../db/repos/teamRepo'
import {
  clearIssues,
  clearOpenIssuesByGroup,
  findIssueByKey,
  findReopenCandidate,
  getIssueMsgs,
  listIssues,
  openIssueAnchorTimes,
  openIssueEvidenceTimes,
  openIssuesForGroup,
  openTopicIndex,
  recentRejectedSamples,
  restoreManualFields,
  setIssueStatus,
  snapshotOpenManualFields,
  upsertIssue,
  type ManualFieldSnapshot,
  type NewIssue,
  type OpenTopicRow
} from '../../db/repos/issueRepo'
import { getConfig, setConfig } from '../../db/repos/config'
import { getDb } from '../../db/database'
import { topicSame } from './issueSimilarity'
import { ruleExtract } from './ruleExtract'
import { analyzeLlmIssues, chunkMainRows, normalizeIssues } from './llmExtract'
import { reconcileOpenIssues } from './reconcile'
import {
  fmtRow,
  isTextLike,
  mergeEvidence,
  msgIdentity,
  readGroupMessages,
  UNREPLIED_MERGE_MS,
  type LlmRow
} from './shared'
import type {
  ChatMessage,
  FeedbackAnalysisState,
  FeedbackIssue,
  FeedbackIssueMsg,
  FeedbackIssueSeverity,
  FeedbackIssueStatus,
  FeedbackIssueType
} from '../../../shared/types'

/**
 * 群问题反馈分析器 —— **编排入口**（看板 + 工作台）。
 *
 * 模块分工（原单文件 1760 行按阶段拆开，便于单独演进/复用）：
 * - shared.ts      消息/文本层公共基础（消息→文本、发送人标签、回合内回复判定、证据合并、跨库读取窗口）
 * - ruleExtract.ts 规则提取（LLM 不可用/失败时的兜底：关键词聚类 + 末尾未回复）
 * - llmExtract.ts  LLM 提取（分批消费主区、按段排版、行号回映射、议题级归一化）
 * - reconcile.ts   规则型跟进/收尾判定（跟进中 / 待处理 / 静默收尾 / 超期搁置）
 * - duplicates.ts  存量重复议题合并（人工预览 + 高置信自动）
 * - 本文件         读取窗口与水位、单群/全量分析编排、进度与取消、对外状态与维护入口
 *
 * 关键口径：
 * - 窗口：增量按水位（时间 + 序号双线）；首次/重算按自然日窗口；
 * - 「已跟进」为会话语义：客户消息之后、下一条客户消息之前出现我方/团队消息即视为已回复，不设固定时间窗；
 * - 团队客服成员（手动全局标识）的消息视同我方；
 * - **规则管跟进、LLM 管闭环**：每轮分析对全部 open 问题做确定性判定，
 *   已回复 → 跟进中并记录回复时刻；未回复 → 待处理；客户静默超阈值 → 自动收尾(done/autoDone)；
 *   锚点超出回溯范围 → 超期自动搁置(stalled)。LLM 只负责语义闭环（客户确认/已解决）；
 * - 落库策略：稳定 key upsert（含 key 漂移兜底合并），重复分析不重置人工处理状态。
 */

${keep.replace(/\s+$/, '')}

// ── 对外保持原有入口（拆模块后调用方无需改动）──
export { ISSUE_TYPES } from './shared'
export { mergeDuplicateIssues } from './duplicates'
export type { DuplicateMergePlanItem, DuplicateMergeResult } from './duplicates'
export { reconcileGroupFollowups } from './reconcile'
export type { ReconcileResult } from './reconcile'
`
fs.writeFileSync('src/main/services/feedback/analyzer.ts', header.replace(/\n{3,}/g, '\n\n'))
console.log('analyzer lines', header.split('\n').length)
