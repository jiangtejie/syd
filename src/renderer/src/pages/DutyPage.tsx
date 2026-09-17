import { useCallback, useMemo, useState } from 'react'
import { useWorkbenchStore } from '../stores/workbench'
import { toast } from '../stores/toast'
import type {
  DutyPreview,
  DutyReply,
  DutyScript,
  DutyScriptInput,
  DutyScriptPattern,
  DutyStats,
  DutyStatus
} from '../../../shared/types'
import { fmtTimeShort as fmtTime } from '../../../shared/monitorMetrics'
import { useAsyncEffect } from '../lib/useAsyncEffect'
import './duty.css'

/**
 * 值班页（数字员工）。
 *
 * 一期是**影子模式**：数字员工照常判定「这条该不该回、按哪条话术回」，但**不发送**，
 * 结果全部落在本页——先让人看清它会怎么答，把话术和风险分级校准到位，再开正式模式。
 *
 * 三个视图：
 * - 影子记录：它最近打算怎么回（可逐条反馈「答得对 / 答错了 / 不该回」，反馈是后续调话术的依据）
 * - 话术库：口径本身（关键词/正则 → 回复模板 + 风险等级），话术优先、LLM 只兜底
 * - 回放预演：拿过去几天的真实消息跑一遍，不写库不发送，用来评估覆盖率
 */

const RISK_LABEL: Record<string, string> = {
  A: 'A 可自动',
  B: 'B 需确认',
  C: 'C 禁自动'
}

const DECISION_LABEL: Record<string, string> = {
  script: '命中话术',
  llm: 'LLM 兜底',
  handoff: '转人工',
  skip: '不介入'
}

/** 意图来源 → 徽标文案（与主进程 intent.ts 的 INTENT_SOURCE_TEXT 保持一致） */
const INTENT_SOURCE_LABEL: Record<string, string> = {
  script: '话术',
  rule: '规则',
  llm: '模型',
  none: '未归类'
}

/** 话术模式列表 ←→ 文本（一行一条：kw: 关键词 / re: 正则） */
function patternsToText(list: DutyScriptPattern[]): string {
  return list.map((p) => `${p.type}: ${p.value}`).join('\n')
}

function textToPatterns(text: string): DutyScriptPattern[] {
  const out: DutyScriptPattern[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const m = /^(kw|re)\s*[:：]\s*(.+)$/i.exec(line)
    if (m) out.push({ type: m[1].toLowerCase() === 're' ? 're' : 'kw', value: m[2].trim() })
    else out.push({ type: 'kw', value: line })
  }
  return out
}

function DutyPage(): React.JSX.Element {
  const wxid = useWorkbenchStore((s) => s.wxid)
  const [status, setStatus] = useState<DutyStatus | null>(null)
  const [stats, setStats] = useState<DutyStats | null>(null)
  const [replies, setReplies] = useState<DutyReply[]>([])
  const [scripts, setScripts] = useState<DutyScript[]>([])
  const [tab, setTab] = useState<'shadow' | 'scripts' | 'preview'>('shadow')
  const [busy, setBusy] = useState<string>('')
  const [preview, setPreview] = useState<DutyPreview | null>(null)
  const [days, setDays] = useState(2)
  const [importText, setImportText] = useState('')
  const [draft, setDraft] = useState<{
    id?: number
    intent: string
    title: string
    patterns: string
    replyText: string
    riskLevel: 'A' | 'B' | 'C'
    priority: number
  }>({ intent: '', title: '', patterns: '', replyText: '', riskLevel: 'A', priority: 100 })

  const api = window.api?.cs?.duty

  const loadAll = useCallback(async (): Promise<void> => {
    if (!wxid || !api) return
    const [st, sc, rp] = await Promise.all([
      api.status(wxid).catch(() => null),
      api.scripts(wxid).catch(() => null),
      api.replies(wxid, { limit: 100 }).catch(() => null)
    ])
    if (st?.ok) {
      setStatus(st.status ?? null)
      setStats(st.stats ?? null)
    }
    if (sc?.ok && sc.scripts) setScripts(sc.scripts)
    if (rp?.ok && rp.replies) setReplies(rp.replies)
  }, [wxid, api])

  // 首次挂载拉一次数据（异步，setState 在 await 之后 —— 统一走 useAsyncEffect）
  useAsyncEffect(loadAll, [loadAll])

  const resetDraft = (): void =>
    setDraft({ intent: '', title: '', patterns: '', replyText: '', riskLevel: 'A', priority: 100 })

  const editScript = (s: DutyScript): void =>
    setDraft({
      id: s.id,
      intent: s.intent,
      title: s.title,
      patterns: patternsToText(s.patterns),
      replyText: s.replyText,
      riskLevel: s.riskLevel,
      priority: s.priority
    })

  const saveDraft = async (): Promise<void> => {
    if (!wxid || !api) return
    const intent = draft.intent.trim()
    const replyText = draft.replyText.trim()
    const patterns = textToPatterns(draft.patterns)
    if (!intent || !replyText || patterns.length === 0) {
      toast.error('意图、触发方式（至少一条）、回复内容都要填')
      return
    }
    setBusy('save')
    const res = await api
      .scriptSave(wxid, {
        id: draft.id,
        intent,
        title: draft.title.trim() || intent,
        patterns,
        replyText,
        riskLevel: draft.riskLevel,
        priority: Number.isFinite(draft.priority) ? draft.priority : 100,
        enabled: true
      })
      .catch(() => null)
    setBusy('')
    if (!res?.ok) {
      toast.error(res?.error || '保存失败')
      return
    }
    if (res.scripts) setScripts(res.scripts)
    toast.success(draft.id ? '话术已更新' : '话术已新增')
    resetDraft()
  }

  const removeScript = async (id: number): Promise<void> => {
    if (!wxid || !api) return
    const res = await api.scriptRemove(wxid, id).catch(() => null)
    if (!res?.ok) {
      toast.error(res?.error || '删除失败')
      return
    }
    if (res.scripts) setScripts(res.scripts)
    toast.success('已删除')
  }

  const toggleScript = async (s: DutyScript): Promise<void> => {
    if (!wxid || !api) return
    const res = await api.scriptToggle(wxid, s.id, !s.enabled).catch(() => null)
    if (res?.ok && res.scripts) setScripts(res.scripts)
  }

  /** 导入：支持完整 JSON（含 patterns）与简化写法 [{intent, kw:[], reply, risk}] */
  const runImport = async (): Promise<void> => {
    if (!wxid || !api) return
    let rows: DutyScriptInput[] = []
    try {
      const parsed = JSON.parse(importText) as Array<Record<string, unknown>>
      rows = parsed
        .map((r) => {
          const intent = String(r.intent ?? r.意图 ?? '').trim()
          const replyText = String(r.replyText ?? r.reply ?? r.回复 ?? '').trim()
          let patterns: DutyScriptPattern[] = []
          if (Array.isArray(r.patterns)) {
            patterns = (r.patterns as Array<Record<string, unknown>>).map((p) => ({
              type: p.type === 're' ? ('re' as const) : ('kw' as const),
              value: String(p.value ?? '')
            }))
          } else {
            const kws = (r.kw ?? r.关键词 ?? []) as unknown
            const list = Array.isArray(kws)
              ? kws
              : typeof kws === 'string'
                ? kws.split(/[,，、]/)
                : []
            patterns = list.map((k) => ({ type: 'kw' as const, value: String(k).trim() }))
          }
          const risk = String(r.riskLevel ?? r.risk ?? r.风险 ?? 'A').toUpperCase()
          return {
            intent,
            title: String(r.title ?? r.标题 ?? intent),
            patterns: patterns.filter((p) => p.value),
            replyText,
            riskLevel: risk === 'B' || risk === 'C' ? (risk as 'B' | 'C') : ('A' as const),
            priority: Number.isFinite(Number(r.priority)) ? Number(r.priority) : 100
          }
        })
        .filter((r) => r.intent && r.replyText && r.patterns.length > 0)
    } catch {
      toast.error(
        'JSON 解析失败：请粘贴数组，如 [{"intent":"物流时效","kw":["什么时候到"],"reply":"…"}]'
      )
      return
    }
    if (rows.length === 0) {
      toast.error('没有解析出可用话术（需要 intent + 关键词 + 回复内容）')
      return
    }
    setBusy('import')
    const res = await api.scriptImport(wxid, rows).catch(() => null)
    setBusy('')
    if (!res?.ok) {
      toast.error(res?.error || '导入失败')
      return
    }
    if (res.scripts) setScripts(res.scripts)
    toast.success(`导入完成：新增 ${res.inserted ?? 0} · 更新 ${res.updated ?? 0}`)
    setImportText('')
  }

  const runNow = async (): Promise<void> => {
    if (!wxid || !api) return
    setBusy('run')
    const res = await api.run(wxid).catch(() => null)
    setBusy('')
    if (!res?.ok) {
      toast.error(res?.error || '执行失败')
      return
    }
    const r = res.result
    toast.success(
      r
        ? `本轮：群 ${r.groups} · 扫 ${r.scanned} · 命中 ${r.decided} · 转人工 ${r.handoff} · 兜底 ${r.llm}`
        : '已执行'
    )
    await loadAll()
  }

  /** 补全历史记录的意图：只跑规则层（零成本），补完刷新列表 */
  const backfillIntent = async (): Promise<void> => {
    if (!api) return
    setBusy('intent')
    const res = await api.backfillIntent(2000).catch(() => null)
    setBusy('')
    if (!res?.ok) {
      toast.error(res?.error || '补全失败')
      return
    }
    const top = (res.byIntent ?? [])
      .slice(0, 4)
      .map((x) => x.intent + ' ' + x.n)
      .join(' · ')
    const filled = String(res.filled ?? 0)
    toast.success('已补全 ' + filled + ' 条意图' + (top ? '：' + top : ''))
    await loadAll()
  }

  /** 导入推荐话术（一期模板）：只承诺动作不承诺事实，风险 C 的只做转人工 */
  const seedStarters = async (): Promise<void> => {
    if (!wxid || !api) return
    setBusy('seed')
    const res = await api.seedStarters(wxid).catch(() => null)
    setBusy('')
    if (!res?.ok) {
      toast.error(res?.error || '导入失败')
      return
    }
    if (res.scripts) setScripts(res.scripts)
    toast.success(`已导入推荐话术：新增 ${res.inserted ?? 0} · 更新 ${res.updated ?? 0}`)
  }

  const runPreview = async (): Promise<void> => {
    if (!wxid || !api) return
    setBusy('preview')
    const res = await api.preview(wxid, { days, limitGroups: 10 }).catch(() => null)
    setBusy('')
    if (!res?.ok) {
      toast.error(res?.error || '预演失败')
      return
    }
    setPreview(res as unknown as DutyPreview)
  }

  const sendFeedback = async (id: number, fb: string): Promise<void> => {
    if (!api) return
    const res = await api.feedback(id, fb).catch(() => null)
    if (!res?.ok) {
      toast.error('反馈失败')
      return
    }
    setReplies((list) => list.map((r) => (r.id === id ? { ...r, feedback: fb } : r)))
    toast.success(fb === 'good' ? '已记为答得对' : fb === 'bad' ? '已记为答错了' : '已记为不该回')
  }

  const shadowList = useMemo(() => replies.filter((r) => r.status === 'shadow'), [replies])
  const handoffList = useMemo(() => replies.filter((r) => r.status === 'queued'), [replies])

  return (
    <div className="page-scroll dt-page">
      <h2 className="page-title">值班 · 数字员工</h2>
      <div className="page-subtitle">
        按话术自动应答客户群；当前为
        <b>{status?.defaultMode === 'live' ? ' 正式模式' : ' 影子模式（只记录不发送）'}</b>
        ，自动回复 <b>{status?.defaultEnabled ? '默认开启' : '默认关闭'}</b>
        {status ? ` · 话术 ${status.scripts} 条 · 单独设置 ${status.overrides} 个群` : ''}
      </div>

      <div className="dt-toolbar">
        <button
          type="button"
          className="ui-btn is-primary dt-btn"
          disabled={busy !== ''}
          onClick={() => void runNow()}
        >
          {busy === 'run' ? '执行中…' : '立即跑一轮'}
        </button>
        {(status?.missingIntent ?? 0) > 0 && (
          <button
            type="button"
            className="ui-btn dt-btn"
            disabled={busy !== ''}
            onClick={() => void backfillIntent()}
            title="历史上走 LLM 兜底的那批记录意图是空的（所以 Base 的意图列一片空白）。这里用规则层离线补齐，不改决策与发送状态。"
          >
            {busy === 'intent'
              ? '补全中…'
              : '补全历史意图（' + (status?.missingIntent ?? 0) + ' 条）'}
          </button>
        )}
        <button
          type="button"
          className="ui-btn dt-btn"
          disabled={busy !== ''}
          onClick={() => void loadAll()}
        >
          刷新
        </button>
        {stats && (
          <span className="dt-stat">
            近 7 天：命中 {stats.script} · 兜底 {stats.llm} · 转人工 {stats.handoff} · 未命中率{' '}
            {(stats.noMatchRate * 100).toFixed(0)}%
          </span>
        )}
        <span className="dt-hint">影子模式下不会发出任何消息；群开关在「客户」页批量管理</span>
      </div>

      <div className="dt-tabs">
        {(
          [
            ['shadow', `影子记录 ${shadowList.length}`],
            ['scripts', `话术库 ${scripts.length}`],
            ['preview', '回放预演']
          ] as const
        ).map(([k, label]) => (
          <button
            key={k}
            type="button"
            className={`ui-tab dt-tab${tab === k ? ' is-active' : ''}`}
            onClick={() => setTab(k)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'shadow' && (
        <div className="dt-list">
          {handoffList.length > 0 && (
            <div className="dt-section-title">
              需人工接手 {handoffList.length} 条（高风险或看不懂的消息）
            </div>
          )}
          {[...handoffList, ...shadowList].map((r) => (
            <div key={r.id} className="dt-card">
              <div className="dt-card-head">
                <span className={`dt-badge is-${r.decision}`}>
                  {DECISION_LABEL[r.decision] ?? r.decision}
                </span>
                <span className="dt-group">{r.groupName || r.groupUsername}</span>
                <span className="dt-time">{fmtTime(r.triggerTime ?? r.createdAt)}</span>
                {r.intent && (
                  <span
                    className="dt-intent"
                    title={
                      '意图来源：' +
                      (INTENT_SOURCE_LABEL[r.intentSource ?? 'none'] ?? '未归类') +
                      (r.intentConfidence ? ' · 置信度 ' + r.intentConfidence : '') +
                      (r.intentEvidence ? ' · 命中：' + r.intentEvidence : '')
                    }
                  >
                    {r.intent}
                    <span className="dt-intent-src">
                      {INTENT_SOURCE_LABEL[r.intentSource ?? 'none'] ?? '未归类'}
                    </span>
                  </span>
                )}
                {r.riskLevel && r.riskLevel !== 'A' && (
                  <span className="dt-risk">{RISK_LABEL[r.riskLevel] ?? r.riskLevel}</span>
                )}
              </div>
              <div className="dt-trigger">客户：{r.triggerText || '（无文本）'}</div>
              {r.replyText && <div className="dt-reply">它打算回：{r.replyText}</div>}
              <div className="dt-reason">{r.reason}</div>
              <div className="dt-ops">
                <button
                  type="button"
                  className={`dt-fb${r.feedback === 'good' ? ' is-on' : ''}`}
                  onClick={() => void sendFeedback(r.id, 'good')}
                >
                  👍 答得对
                </button>
                <button
                  type="button"
                  className={`dt-fb${r.feedback === 'bad' ? ' is-on' : ''}`}
                  onClick={() => void sendFeedback(r.id, 'bad')}
                >
                  👎 答错了
                </button>
                <button
                  type="button"
                  className={`dt-fb${r.feedback === 'no-reply' ? ' is-on' : ''}`}
                  onClick={() => void sendFeedback(r.id, 'no-reply')}
                >
                  🚫 不该回
                </button>
              </div>
            </div>
          ))}
          {replies.length === 0 && (
            <div className="dt-empty">
              还没有记录。影子模式会在群里有新消息时自动判定，也可以点「立即跑一轮」。
            </div>
          )}
        </div>
      )}

      {tab === 'scripts' && (
        <div className="dt-scripts">
          <div className="dt-toolbar">
            <button
              type="button"
              className="ui-btn dt-btn"
              disabled={busy !== ''}
              onClick={() => void seedStarters()}
              title="导入 13 条常用话术（问到货/发票/对账单/物流…）：只承诺动作，不承诺具体时间与数字；退款/投诉/合同类只转人工"
            >
              {busy === 'seed' ? '导入中…' : '导入推荐话术模板'}
            </button>
            <span className="dt-hint">
              一期原则：数字员工只「接住话头 + 承诺动作」，不编造到货时间/库存数字 ——
              那些等二期接订单与物流查询
            </span>
          </div>
          <div className="dt-form">
            <div className="dt-form-title">{draft.id ? `编辑话术 #${draft.id}` : '新增话术'}</div>
            <div className="dt-form-row">
              <input
                className="ui-input dt-input"
                placeholder="意图（如 物流时效）"
                value={draft.intent}
                onChange={(e) => setDraft({ ...draft, intent: e.target.value })}
              />
              <input
                className="ui-input dt-input"
                placeholder="展示名（可空）"
                value={draft.title}
                onChange={(e) => setDraft({ ...draft, title: e.target.value })}
              />
              <select
                className="ui-input ui-select dt-input dt-select"
                value={draft.riskLevel}
                onChange={(e) =>
                  setDraft({ ...draft, riskLevel: e.target.value as 'A' | 'B' | 'C' })
                }
                title="A=可自动发；B=需人工确认；C=永不自动（价格/退款/投诉/合同）"
              >
                <option value="A">A 可自动</option>
                <option value="B">B 需确认</option>
                <option value="C">C 禁自动</option>
              </select>
              <input
                className="ui-input dt-input dt-num"
                type="number"
                value={draft.priority}
                onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                title="优先级（小者先命中）"
              />
            </div>
            <textarea
              className="ui-textarea dt-textarea"
              rows={3}
              placeholder={'触发方式，一行一条：\nkw: 什么时候到\nkw: 几天能到\nre: 订单\\s*\\d+'}
              value={draft.patterns}
              onChange={(e) => setDraft({ ...draft, patterns: e.target.value })}
            />
            <textarea
              className="ui-textarea dt-textarea"
              rows={3}
              placeholder={'回复内容（可用变量：{{客户名}} {{群名}} {{日期}} {{时间}}）'}
              value={draft.replyText}
              onChange={(e) => setDraft({ ...draft, replyText: e.target.value })}
            />
            <div className="dt-form-ops">
              <button
                type="button"
                className="ui-btn is-primary dt-btn"
                disabled={busy !== ''}
                onClick={() => void saveDraft()}
              >
                {draft.id ? '保存修改' : '新增话术'}
              </button>
              {draft.id && (
                <button type="button" className="ui-btn dt-btn" onClick={resetDraft}>
                  取消编辑
                </button>
              )}
            </div>
            <details className="dt-import">
              <summary>批量导入（模板/JSON）</summary>
              <textarea
                className="ui-textarea dt-textarea"
                rows={4}
                placeholder={
                  '[{"intent":"物流时效","kw":["什么时候到","几天能到"],"reply":"一般 3-5 天到店，我帮您盯一下物流","risk":"A"}]'
                }
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
              />
              <button
                type="button"
                className="ui-btn dt-btn"
                disabled={busy !== '' || !importText.trim()}
                onClick={() => void runImport()}
              >
                {busy === 'import' ? '导入中…' : '导入'}
              </button>
            </details>
          </div>

          <div className="dt-table">
            <div className="dt-tr dt-th">
              <span>启用</span>
              <span>意图 / 触发方式</span>
              <span>回复</span>
              <span>风险</span>
              <span>命中</span>
              <span>操作</span>
            </div>
            {scripts.map((s) => (
              <div key={s.id} className={`dt-tr${s.enabled ? '' : ' is-off'}`}>
                <span>
                  <input
                    type="checkbox"
                    checked={s.enabled}
                    onChange={() => void toggleScript(s)}
                  />
                </span>
                <span className="dt-tr-main">
                  <b>{s.title || s.intent}</b>
                  <span className="dt-tr-sub">
                    {s.patterns
                      .map((p) => `${p.type === 're' ? '正则' : ''}${p.value}`)
                      .join(' / ')}
                  </span>
                </span>
                <span className="dt-tr-reply">{s.replyText}</span>
                <span className={`dt-risk is-${s.riskLevel}`}>{RISK_LABEL[s.riskLevel]}</span>
                <span className="dt-muted">{s.hitCount}</span>
                <span className="dt-tr-ops">
                  <button type="button" className="dt-mini" onClick={() => editScript(s)}>
                    编辑
                  </button>
                  <button
                    type="button"
                    className="dt-mini danger"
                    onClick={() => void removeScript(s.id)}
                  >
                    删除
                  </button>
                </span>
              </div>
            ))}
            {scripts.length === 0 && (
              <div className="dt-empty">
                还没有话术。先加几条最常见的（物流时效 / 营业时间 / 地址 / 发票），或批量导入模板。
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'preview' && (
        <div className="dt-preview">
          <div className="dt-toolbar">
            <span className="dt-hint">拿最近几天的真实群消息跑一遍判定（不写库、不发送）</span>
            <select
              className="ui-input ui-select dt-input dt-select"
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
            >
              {[1, 2, 3, 7].map((d) => (
                <option key={d} value={d}>
                  近 {d} 天
                </option>
              ))}
            </select>
            <button
              type="button"
              className="ui-btn is-primary dt-btn"
              disabled={busy !== ''}
              onClick={() => void runPreview()}
            >
              {busy === 'preview' ? '预演中…' : '开始预演'}
            </button>
          </div>
          {preview && (
            <>
              <div className="dt-stat-line">
                群 {preview.totals.groups} · 消息 {preview.totals.msgs} · 会回{' '}
                {preview.totals.decisions} · 转人工 {preview.totals.handoff} · 非文本（图片/语音）
                {preview.totals.nonText}
              </div>
              {preview.intents.length > 0 && (
                <div className="dt-intents">
                  {preview.intents.map((it) => (
                    <span key={it.intent} className="dt-intent-chip">
                      {it.intent} × {it.n}
                    </span>
                  ))}
                </div>
              )}
              <div className="dt-list">
                {preview.samples.slice(0, 60).map((s, i) => (
                  <div key={i} className="dt-card">
                    <div className="dt-card-head">
                      <span className={`dt-badge is-${s.action}`}>
                        {s.action === 'reply'
                          ? '会回'
                          : s.action === 'confirm'
                            ? '需确认'
                            : s.action === 'handoff'
                              ? '转人工'
                              : '需兜底'}
                      </span>
                      <span className="dt-group">{s.groupName}</span>
                      <span className="dt-time">{fmtTime(s.time)}</span>
                      <span className="dt-muted">{s.sender}</span>
                      {s.intent && <span className="dt-intent">{s.intent}</span>}
                    </div>
                    <div className="dt-trigger">{s.text}</div>
                    {s.reply && <div className="dt-reply">{s.reply}</div>}
                    <div className="dt-reason">{s.reason}</div>
                  </div>
                ))}
              </div>
            </>
          )}
          {!preview && (
            <div className="dt-empty">点「开始预演」看它在你们群里的表现（预演不会发消息）</div>
          )}
        </div>
      )}
    </div>
  )
}

export default DutyPage
