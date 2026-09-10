import fs from 'fs'
const src = fs.readFileSync('src/main/services/feedback/analyzer.ts', 'utf8').split(/\r?\n/)
const starts = []
const re = /^(?:export )?(?:async )?function \w+|^export interface \w+|^interface \w+|^export type \w+|^type \w+|^(?:export )?const [A-Za-z_0-9]+(?:\s*:[^=]+)? =/
src.forEach((l, i) => { if (re.test(l)) starts.push(i) })
const blocks = []
for (let k = 0; k < starts.length; k++) {
  const end = k + 1 < starts.length ? starts[k + 1] : src.length
  blocks.push(src.slice(starts[k], end))
}
for (let k = 0; k < blocks.length - 1; k++) {
  const b = blocks[k]
  let cut = b.length
  while (cut > 1 && /^\s*(\/\*\*|\*|\/\/)/.test(b[cut - 1])) cut--
  const moved = b.slice(cut)
  blocks[k] = b.slice(0, cut)
  blocks[k + 1] = [...moved, ...blocks[k + 1]]
}
const byName = new Map()
for (const b of blocks) {
  const text = b.join('\n').replace(/\s+$/, '')
  const m = text.match(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)|^(?:export )?(?:interface|type) (\w+)/m)
  if (m) byName.set(m[1] || m[2] || m[3], text)
}
const take = (names) => names.map((n) => {
  if (!byName.has(n)) throw new Error('missing block: ' + n)
  return byName.get(n)
}).join('\n\n')
const mods = {
  shared: ['ISSUE_TYPES','normalizeSeverity','normalizeType','msgToText','isTeamMsg','msgToSummaryMsg','senderLabel','isTextLike','isRuleText','staffReplyAt','hasStaffReplyAfter','msgIdentity','mergeEvidence','EVIDENCE_CAP','SEGMENT_GAP_MS','segmentizeLines','LlmRow','LlmLineRef','LlmLineResolver','fmtRow','MAX_GROUP_MSGS','READ_PAGE','ReadResult','readGroupMessages','UNREPLIED_MERGE_MS','INCR_TAIL_MS'],
  ruleExtract: ['RULE_KEYWORDS','RULE_SEV_BASE','RULE_SEV_BOOST','RULE_CLUSTER_MS','RULE_EVIDENCE_CAP','ruleExtract'],
  llmExtract: ['LLM_LINES_CAP','LLM_CHUNK_ROWS','LlmIssue','parseLlmJson','normalizeIssues','chunkMainRows','APX_BASE','APX_MAX','analyzeLlmIssues'],
  reconcile: ['AUTO_CLOSE_MAX_AGE_MS','ANCHOR_TOLERANCE_MS','AUTO_CLOSE_SILENT_HOURS','ReconcileResult','silentCloseAt','reconcileOpenIssues','reconcileGroupFollowups'],
  duplicates: ['DuplicateMergePlanItem','DuplicateMergeResult','mergeDuplicateIssues'],
  __keep: ['WINDOW_DAYS','MAX_GROUPS','GROUP_AUTO_REANALYZE_MS','groupStampKey','GroupStamp','readGroupStamp','groupRunKeys','IssueCoverage','AnalyzeGroupResult','wmKey','WmValue','readWm','saveWm','clearGroupRunState','peekLatestRow','buildRows','fallbackRuleIssues','analyzeGroupIssues','IssueProgress','IssueProgressSink','setIssueProgressSink','cancelRequested','cancelIssuesAnalysis','runningWxids','stateConfigKey','failConfigKey','analyzeIssues','hasGroupWatermark','readState','listFeedbackIssues','updateIssueStatus','clearFeedbackIssues','INCR_TAIL_ROWS']
}
const out = {}
for (const [k, names] of Object.entries(mods)) out[k] = take(names)
fs.writeFileSync('dsh-mod-blocks.json', JSON.stringify(out))
for (const [k, v] of Object.entries(out)) console.log(k, 'lines=' + v.split('\n').length)
