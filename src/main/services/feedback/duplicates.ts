/**
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

export interface DuplicateMergePlanItem {
  /** 保留的议题 id（组内最早发生的一条） */
  keepId: number
  keepTitle: string
  /** 归档为「重复」的议题 id 与其标题 */
  dropIds: number[]
  dropTitles: string[]
  groupName: string
  /** 判定理由（人工复核用） */
  reasons: string[]
  /** 高置信（强信号连通）：开启自动合并后由后台直接处理 */
  strong: boolean
  /** 本可自动合并、但组内存在多个不同跟进人 → 留给人工决定归属 */
  skippedAuto?: boolean
}

export interface DuplicateMergeResult {
  /** 重复组数 */
  clusters: number
  /** 被归档的重复行数 */
  merged: number
  plan: DuplicateMergePlanItem[]
}

/**
 * 存量去重：把历史上因锚点漂移产生的重复议题合并回一条。
 * - 判据与实时合并完全一致（issueSimilarity.topicSame），因此清理之后新提取不会再生成同类重复；
 * - 每组保留最早发生的一条：合并证据（去重后按时间排序、限容）、取最高严重度、并集客户、沿用指派跟进人；
 * - 其余归档为「重复」(archived_from='duplicate')——不计入闭环率/趋势，也不作为 LLM 反例样本；
 * - dryRun=true 只返回方案供 UI 预览确认，不写库。
 */
export function mergeDuplicateIssues(
  wxid: string,
  opts: {
    dryRun?: boolean
    /** 只处理高置信组（后台自动合并用：弱信号一律留给人工在监控页预览确认） */
    strongOnly?: boolean
  } = {}
): DuplicateMergeResult {
  const result: DuplicateMergeResult = { clusters: 0, merged: 0, plan: [] }
  if (!wxid) return result
  const open = listIssues(wxid, { status: 'open' })
  if (open.length < 2) return result
  const byGroup = new Map<string, FeedbackIssue[]>()
  for (const it of open) {
    const arr = byGroup.get(it.groupUsername)
    if (arr) arr.push(it)
    else byGroup.set(it.groupUsername, [it])
  }
  for (const [group, list] of byGroup) {
    if (list.length < 2) continue
    const idx = new Map(openTopicIndex(wxid, group).map((r) => [r.id, r]))
    const rows = list.map((it) => {
      const facts = idx.get(it.id)
      return {
        id: it.id,
        key: it.key,
        title: it.title,
        type: it.type,
        occurAt: it.occurAt,
        customers: it.customers,
        usernames: facts?.usernames ?? [],
        evidenceTimes: facts?.evidenceTimes ?? [],
        ref: it
      }
    })
    const clusters = clusterTopics(rows, {
      timeGapFor: (x, y) =>
        x.key.includes(':unreplied:') || y.key.includes(':unreplied:')
          ? UNREPLIED_MERGE_MS
          : TOPIC_TIME_NEAR_MS
    })
    for (const c of clusters) {
      const members = c.members
      const keep = members.reduce((x, y) =>
        y.occurAt < x.occurAt || (y.occurAt === x.occurAt && y.id < x.id) ? y : x
      )
      const drops = members.filter((m) => m.id !== keep.id)
      // 自动合并的安全阀：组内若有多个不同跟进人，归属需要人来定，不自动并
      const assignees = new Set(members.map((m) => m.ref.assignee).filter((x) => !!x))
      const autoSafe = c.strong && assignees.size <= 1
      if (opts.strongOnly && !autoSafe) continue
      result.plan.push({
        keepId: keep.id,
        keepTitle: keep.title,
        dropIds: drops.map((d) => d.id),
        dropTitles: drops.map((d) => d.title),
        groupName: keep.ref.groupName || group,
        reasons: c.reasons,
        strong: c.strong,
        skippedAuto: c.strong && assignees.size > 1
      })
      result.merged += drops.length
      if (opts.dryRun) continue
      // 表达用字段：规则提取的标题是原文摘录，同组里有 LLM 概括时优先用它
      const llm = members
        .filter((m) => m.ref.method === 'llm')
        .sort((x, y) => x.occurAt - y.occurAt)[0]
      const src = keep.ref.method === 'rule' && llm ? llm.ref : keep.ref
      const severity: FeedbackIssueSeverity = members.some((m) => m.ref.severity === '紧急')
        ? '紧急'
        : members.some((m) => m.ref.severity === '高')
          ? '高'
          : (keep.ref.severity ?? '一般')
      const customers = Array.from(
        new Set(
          members
            .flatMap((m) => m.ref.customers ?? [])
            .map((x) => x.trim())
            .filter(Boolean)
        )
      ).slice(0, 6)
      applyIssueMerge({
        id: keep.id,
        title: src.title,
        summary: src.summary,
        type: src.type,
        severity,
        customers: customers.length > 0 ? customers : undefined,
        occurAt: members.reduce((mn, m) => Math.min(mn, m.occurAt), keep.occurAt),
        // 疑似口径取「有人确认过就算已确认」：合并本身不该把议题重新丢回疑似桶
        needConfirm: members.some((m) => !m.ref.needConfirm) ? 0 : 1,
        assignee: members.map((m) => m.ref.assignee).find((x) => !!x) ?? null,
        reopenCount: members.reduce((mx, m) => Math.max(mx, m.ref.reopenCount ?? 0), 0),
        msgs: mergeEvidence(
          [],
          members.flatMap((m) => getIssueMsgs(m.id))
        )
      })
      archiveDuplicates(drops.map((d) => d.id))
    }
  }
  result.clusters = result.plan.length
  return result
}
