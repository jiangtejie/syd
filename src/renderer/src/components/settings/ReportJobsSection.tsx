import { useEffect, useState } from 'react'
import type {
  KeyAccountInfo,
  ReportJobInfo,
  ReportJobInput,
  ReportRunInfo
} from '../../../../shared/types'
import {
  REPORT_SCHEDULE_LABEL,
  REPORT_SESSION_MODE_LABEL,
  REPORT_TYPE_LABEL
} from '../../../../shared/types'
import { SettingsCard, SwitchRow, FieldRow } from './ui'
import { toast } from '../../stores/toast'
import { confirmAsk } from '../../stores/confirmDialog'

/**
 * 设置 → 定时任务:数据上报任务管理(chat_sync:本地微信聊天记录 → PostgreSQL)。
 * 支持:新建/编辑(数据范围+目标库+调度)、启停、立即执行、测试连接、运行历史。
 */

const reportApi = window.api?.cs?.report
const keyStoreApi = window.api?.cs?.keyStore

const emptyForm = (): ReportJobInput => ({
  name: '',
  type: 'chat_sync',
  enabled: false,
  scheduleKind: 'interval',
  intervalSec: 300,
  dailyTime: '09:00',
  accountWxid: '',
  scope: { sessionMode: 'all', sessionList: '', daysBack: 30, maxPerRun: 0 },
  target: { host: '', port: 5432, database: '', user: '', schema: 'chat', password: '' }
})

function timeAgo(ms?: number): string {
  if (!ms) return '从未运行'
  const diff = Math.max(0, Date.now() - ms)
  if (diff < 60_000) return '刚刚'
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)} 分钟前`
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)} 小时前`
  return `${Math.floor(diff / 86400_000)} 天前`
}

function fmtClock(ms?: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

export default function ReportJobsSection(): React.JSX.Element {
  const [jobs, setJobs] = useState<ReportJobInfo[] | null>(null)
  const [wxAccounts, setWxAccounts] = useState<KeyAccountInfo[]>([])
  const [form, setForm] = useState<ReportJobInput>(emptyForm())
  const [editId, setEditId] = useState<number | null>(null)
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [busyId, setBusyId] = useState<number | null>(null)
  const [testing, setTesting] = useState(false)
  const [prog, setProg] = useState<
    Record<
      number,
      {
        running: boolean
        phase?: string
        status?: string
        summary?: string
        total?: number
        done?: number
        added?: number
        elapsedMs?: number
      }
    >
  >({})
  const [history, setHistory] = useState<{
    job: ReportJobInfo
    runs: ReportRunInfo[] | null
  } | null>(null)

  const load = async (): Promise<void> => {
    const res = await reportApi?.list().catch(() => null)
    if (res?.ok && res.jobs) setJobs(res.jobs as ReportJobInfo[])
    else setJobs([])
  }
  const loadAccounts = async (): Promise<void> => {
    let list: KeyAccountInfo[] | null = null
    for (let i = 0; i < 5 && list === null; i++) {
      if (i > 0) await new Promise((r) => setTimeout(r, 1200))
      list = (await keyStoreApi?.list().catch(() => null)) ?? null
    }
    setWxAccounts(list ?? [])
  }
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取任务与账号(全仓同款模式)
    void load()
    void loadAccounts()
  }, [])

  // 运行进度订阅:任务行实时显示同步进度;结束后刷新列表并复位按钮态
  useEffect(() => {
    const off = reportApi?.onProgress?.((p) => {
      const ev = p as {
        jobId: number
        running: boolean
        phase?: string
        status?: string
        summary?: string
        total?: number
        done?: number
        added?: number
        elapsedMs?: number
      }
      if (!ev || typeof ev.jobId !== 'number') return
      setProg((prev) => ({ ...prev, [ev.jobId]: ev }))
      if (!ev.running) {
        setBusyId((b) => (b === ev.jobId ? null : b))
        void load()
        window.setTimeout(() => {
          setProg((prev) => {
            if (!prev[ev.jobId]) return prev
            const next = { ...prev }
            delete next[ev.jobId]
            return next
          })
        }, 5000)
      }
    })
    return off
  }, [])

  const patchForm = (p: Partial<ReportJobInput>): void => setForm((f) => ({ ...f, ...p }))
  const patchScope = (p: Partial<ReportJobInput['scope']>): void =>
    setForm((f) => ({ ...f, scope: { ...f.scope, ...p } }))
  const patchTarget = (p: Partial<ReportJobInput['target']>): void =>
    setForm((f) => ({ ...f, target: { ...f.target, ...p } }))

  const startNew = (): void => {
    setEditId(null)
    setForm(emptyForm())
    setOpen(true)
  }
  const editJob = (j: ReportJobInfo): void => {
    setEditId(j.id)
    setForm({
      id: j.id,
      name: j.name,
      type: 'chat_sync',
      enabled: j.enabled,
      scheduleKind: j.scheduleKind,
      intervalSec: j.intervalSec || 300,
      dailyTime: j.dailyTime || '09:00',
      accountWxid: j.accountWxid,
      scope: { ...j.scope },
      target: { ...j.target, password: '' }
    })
    setOpen(true)
  }

  const save = async (): Promise<void> => {
    if (!form.name.trim()) {
      toast.error('请填写任务名称')
      return
    }
    if (!form.accountWxid) {
      toast.error('请选择数据来源账号')
      return
    }
    const t = form.target
    if (!t.host.trim() || !t.database.trim() || !t.user.trim()) {
      toast.error('请填写完整目标连接(主机/库名/用户)')
      return
    }
    if (editId === null && !(t.password ?? '').trim()) {
      toast.error('新建任务需填写目标库口令')
      return
    }
    setSaving(true)
    try {
      const res = await reportApi?.save(form).catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '保存失败')
        return
      }
      toast.success(editId !== null ? '任务已保存' : '任务已创建')
      setOpen(false)
      await load()
    } finally {
      setSaving(false)
    }
  }

  const remove = async (j: ReportJobInfo): Promise<void> => {
    const ok = await confirmAsk({
      title: '删除定时任务',
      message: `删除定时任务「${j.name}」?将同时删除其增量游标与运行历史。`,
      confirmText: '删除',
      danger: true
    })
    if (!ok) return
    const res = await reportApi?.remove(j.id).catch(() => null)
    if (res?.ok) {
      toast.success('已删除')
      // 正在编辑的就是这条 → 退回新建态,否则表单会挂着一个已经不存在的 id(保存时报错或误建)
      if (editId === j.id) {
        setEditId(null)
        setForm(emptyForm())
      }
      await load()
    } else {
      toast.error((res as { error?: string } | null)?.error || '删除失败')
    }
  }
  const toggle = async (j: ReportJobInfo): Promise<void> => {
    const res = await reportApi?.setEnabled(j.id, !j.enabled).catch(() => null)
    if (res?.ok) {
      toast.success(!j.enabled ? '已启用,将按调度自动上报' : '已停用')
      await load()
    } else {
      toast.error((res as { error?: string } | null)?.error || '操作失败')
    }
  }
  const runNow = async (j: ReportJobInfo): Promise<void> => {
    setBusyId(j.id)
    try {
      const res = await reportApi?.runNow(j.id).catch(() => null)
      if (res?.ok) toast.success(res.summary || '本轮执行完成')
      else toast.error((res as { error?: string } | null)?.error || '执行失败')
      await load()
    } finally {
      setBusyId(null)
    }
  }
  const cancelRun = async (j: ReportJobInfo): Promise<void> => {
    const res = await reportApi?.cancel(j.id).catch(() => null)
    if (res?.ok) toast.success('已请求停止,当前轮将尽快结束(已入库数据保留)')
    else toast.error((res as { error?: string } | null)?.error || '取消失败')
  }
  const openHistory = async (j: ReportJobInfo): Promise<void> => {
    setHistory({ job: j, runs: null })
    const res = await reportApi?.history(j.id).catch(() => null)
    if (res?.ok && res.runs) setHistory({ job: j, runs: res.runs as ReportRunInfo[] })
    else setHistory({ job: j, runs: [] })
  }
  const testConn = async (): Promise<void> => {
    setTesting(true)
    try {
      const t = form.target
      const res = await reportApi
        ?.testConn({
          target: { ...t, password: t.password?.trim() || undefined },
          jobId: editId ?? undefined
        })
        .catch(() => null)
      if (res?.ok) toast.success('连接成功:目标库可达')
      else toast.error((res as { error?: string } | null)?.error || '连接失败')
    } finally {
      setTesting(false)
    }
  }

  const scheduleText = (j: ReportJobInfo): string =>
    j.scheduleKind === 'interval'
      ? `每 ${Math.round((j.intervalSec || 0) / 60) >= 1 ? `${Math.round((j.intervalSec || 0) / 60)} 分钟` : `${j.intervalSec} 秒`}`
      : j.scheduleKind === 'daily'
        ? `每天 ${j.dailyTime}`
        : '仅手动执行'
  const targetText = (j: ReportJobInfo): string =>
    `${j.target.user}@${j.target.host}:${j.target.port}/${j.target.database}`
  const scopeText = (j: ReportJobInfo): string => {
    const m = REPORT_SESSION_MODE_LABEL[j.scope.sessionMode] ?? j.scope.sessionMode
    const extra =
      j.scope.sessionMode === 'list'
        ? `(${(j.scope.sessionList ?? '').split(/[\s,，]+/).filter(Boolean).length} 个)`
        : j.scope.daysBack > 0
          ? `首轮回溯 ${j.scope.daysBack} 天`
          : ''
    return `${m}${extra ? ` ${extra}` : ''}`
  }

  const STATUS_CLS: Record<string, string> = {
    ok: 'rp-st-ok',
    fail: 'rp-st-fail',
    running: '',
    interrupted: 'rp-st-fail'
  }

  return (
    <div className="st-grid wb-skills-full">
      <SettingsCard
        title="定时任务 · 数据上报"
        desc="把本地微信聊天记录增量上报到你配置的 PostgreSQL(与 chat-sync 表结构兼容),供外部系统/智能体查询。任务按「来源账号」唯一;口令以系统加密存储,界面不显示明文。"
      >
        <div className="st-actions wb-skills-toolbar">
          <button type="button" className="ui-btn is-primary" onClick={startNew}>
            ＋ 新建上报任务
          </button>
          <span className="st-hint rp-warn">
            上报会把客户聊天内容发送到外部数据库——请确认目标可信、账号权限收敛。
          </span>
        </div>
        {jobs === null && <div className="st-hint">加载中…</div>}
        {jobs !== null && jobs.length === 0 && (
          <div className="st-hint">
            暂无任务。点「新建上报任务」:选来源账号与范围 → 填目标库连接 →
            设调度,保存后按调度自动增量上报。
          </div>
        )}
        <div className="rp-job-list">
          {jobs?.map((j) => (
            <div key={j.id} className="rp-job">
              <div className="rp-job-main">
                <div className="rp-job-head">
                  <b>{j.name}</b>
                  <span className="mcp-kind">{REPORT_TYPE_LABEL[j.type] ?? j.type}</span>
                  {j.enabled ? (
                    <span className="mcp-on">启用</span>
                  ) : (
                    <span className="mcp-off">停用</span>
                  )}
                  <span className="rp-job-sched">{scheduleText(j)}</span>
                </div>
                <div className="rp-job-meta">
                  <span>来源:{j.accountWxid}</span>
                  <span>范围:{scopeText(j)}</span>
                  <span>目标:{targetText(j)}</span>
                  {j.scope.maxPerRun > 0 && <span>单轮≤{j.scope.maxPerRun}条</span>}
                </div>
                <div className="rp-job-last">
                  最近 {fmtClock(j.lastAt)}（{timeAgo(j.lastAt)}）
                  {j.lastStatus ? (
                    <>
                      ·
                      <span className={STATUS_CLS[j.lastStatus] ?? ''}>
                        {j.lastStatus === 'ok'
                          ? '成功'
                          : j.lastStatus === 'fail'
                            ? '失败'
                            : j.lastStatus}
                      </span>
                      {j.lastSummary ? ` ${j.lastSummary}` : ''}
                    </>
                  ) : null}
                </div>
                {prog[j.id]?.running === true && (
                  <div className="rp-job-run">
                    {(prog[j.id]?.phase ?? 'sessions') === 'media'
                      ? '媒体归档中…'
                      : `同步中:会话 ${prog[j.id]?.done ?? 0}/${prog[j.id]?.total ?? 0}`}
                    {' · '}新增 {prog[j.id]?.added ?? 0} 条
                    {prog[j.id]?.elapsedMs !== undefined
                      ? ` · ${Math.round((prog[j.id]?.elapsedMs ?? 0) / 1000)}s`
                      : ''}
                  </div>
                )}
              </div>
              <div className="mcp-item-ops">
                {busyId === j.id ? (
                  <button
                    type="button"
                    className="ui-btn is-danger is-sm"
                    onClick={() => void cancelRun(j)}
                  >
                    停止
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ui-btn is-sm"
                    disabled={busyId !== null}
                    onClick={() => void runNow(j)}
                  >
                    立即执行
                  </button>
                )}
                <button type="button" className="ui-btn is-sm" onClick={() => void openHistory(j)}>
                  历史
                </button>
                <button type="button" className="ui-btn is-sm" onClick={() => editJob(j)}>
                  编辑
                </button>
                <button type="button" className="ui-btn is-sm" onClick={() => void toggle(j)}>
                  {j.enabled ? '停用' : '启用'}
                </button>
                <button
                  type="button"
                  className="ui-btn is-danger is-sm"
                  onClick={() => void remove(j)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}
        </div>
      </SettingsCard>

      {open && (
        <SettingsCard title={editId !== null ? `编辑任务 · ${form.name}` : '新建上报任务'}>
          <FieldRow label="任务名称">
            <input
              className="st-input"
              value={form.name}
              onChange={(e) => patchForm({ name: e.target.value })}
              placeholder="如:客户群消息上报"
            />
          </FieldRow>
          <FieldRow label="来源账号" hint="该账号的本地微信聊天记录(需已导入密钥)">
            <select
              className="st-input"
              value={form.accountWxid}
              onChange={(e) => patchForm({ accountWxid: e.target.value })}
            >
              <option value="">选择来源账号…</option>
              {wxAccounts.map((k) => (
                <option key={k.wxid} value={k.wxid}>
                  {k.wxid}
                  {k.source === 'manual' ? '(手动导入)' : ''}
                </option>
              ))}
            </select>
          </FieldRow>
          <FieldRow label="会话范围">
            <select
              className="st-input"
              value={form.scope.sessionMode}
              onChange={(e) =>
                patchScope({
                  sessionMode: e.target.value as ReportJobInput['scope']['sessionMode']
                })
              }
            >
              {(['all', 'groups', 'single', 'list'] as const).map((m) => (
                <option key={m} value={m}>
                  {REPORT_SESSION_MODE_LABEL[m]}
                </option>
              ))}
            </select>
          </FieldRow>
          {form.scope.sessionMode === 'list' && (
            <FieldRow label="会话白名单" hint="每行一个会话 id(群 xxx@chatroom / 单聊 wxid)">
              <textarea
                className="st-input im-allow-area"
                rows={4}
                value={form.scope.sessionList ?? ''}
                onChange={(e) => patchScope({ sessionList: e.target.value })}
                placeholder="xxx@chatroom&#10;wxid_xxxx"
              />
            </FieldRow>
          )}
          <div className="st-grid rp-form-grid">
            <FieldRow label="首轮回溯" hint="天;0=全部历史(首轮慢)">
              <input
                type="number"
                min={0}
                max={3650}
                className="st-input st-th-input"
                value={form.scope.daysBack}
                onChange={(e) => patchScope({ daysBack: Number(e.target.value) || 0 })}
              />
            </FieldRow>
            <FieldRow label="单轮上限" hint="0=不限;防单轮过大">
              <input
                type="number"
                min={0}
                className="st-input st-th-input"
                value={form.scope.maxPerRun}
                onChange={(e) => patchScope({ maxPerRun: Number(e.target.value) || 0 })}
              />
            </FieldRow>
            <FieldRow label="每轮会话数" hint="0=不限;首轮全量可切小,未处理会话下轮自动续">
              <input
                type="number"
                min={0}
                className="st-input st-th-input"
                value={form.scope.sessionsPerRun ?? 0}
                onChange={(e) => patchScope({ sessionsPerRun: Number(e.target.value) || 0 })}
              />
            </FieldRow>
          </div>
          <div className="st-subtitle">目标库(PostgreSQL · chat_sync 兼容 schema)</div>
          <div className="st-grid rp-form-grid">
            <FieldRow label="主机">
              <input
                className="st-input"
                value={form.target.host}
                onChange={(e) => patchTarget({ host: e.target.value })}
                placeholder="127.0.0.1"
              />
            </FieldRow>
            <FieldRow label="端口">
              <input
                type="number"
                className="st-input st-th-input"
                value={form.target.port}
                onChange={(e) => patchTarget({ port: Number(e.target.value) || 5432 })}
              />
            </FieldRow>
          </div>
          <div className="st-grid rp-form-grid">
            <FieldRow label="库名">
              <input
                className="st-input"
                value={form.target.database}
                onChange={(e) => patchTarget({ database: e.target.value })}
                placeholder="goclaw_test"
              />
            </FieldRow>
            <FieldRow label="schema">
              <input
                className="st-input"
                value={form.target.schema}
                onChange={(e) => patchTarget({ schema: e.target.value })}
                placeholder="chat"
              />
            </FieldRow>
          </div>
          <FieldRow label="用户">
            <input
              className="st-input"
              value={form.target.user}
              onChange={(e) => patchTarget({ user: e.target.value })}
              placeholder="root / wechat_reader"
            />
          </FieldRow>
          <FieldRow label="口令" hint={editId !== null ? '留空表示沿用已保存口令' : '系统加密保存'}>
            <input
              type="password"
              className="st-input"
              value={form.target.password ?? ''}
              onChange={(e) => patchTarget({ password: e.target.value })}
              placeholder={editId !== null ? '留空沿用原口令' : '数据库口令'}
            />
          </FieldRow>
          <div className="st-actions">
            <button
              type="button"
              className="ui-btn is-sm"
              disabled={testing}
              onClick={() => void testConn()}
            >
              {testing ? '测试中…' : '测试连接'}
            </button>
          </div>
          <div className="st-subtitle">调度</div>
          <FieldRow label="触发方式">
            <select
              className="st-input"
              value={form.scheduleKind}
              onChange={(e) =>
                patchForm({ scheduleKind: e.target.value as ReportJobInput['scheduleKind'] })
              }
            >
              {(['interval', 'daily', 'manual'] as const).map((k) => (
                <option key={k} value={k}>
                  {REPORT_SCHEDULE_LABEL[k]}
                </option>
              ))}
            </select>
          </FieldRow>
          {form.scheduleKind === 'interval' && (
            <FieldRow label="间隔" hint="秒;≥30(常用 300=5 分钟)">
              <input
                type="number"
                min={30}
                step={30}
                className="st-input st-th-input"
                value={form.intervalSec ?? 300}
                onChange={(e) => patchForm({ intervalSec: Number(e.target.value) || 300 })}
              />
            </FieldRow>
          )}
          {form.scheduleKind === 'daily' && (
            <FieldRow label="每日时刻" hint="HH:mm,错过则次日执行">
              <input
                className="st-input st-th-input"
                value={form.dailyTime ?? '09:00'}
                onChange={(e) => patchForm({ dailyTime: e.target.value })}
              />
            </FieldRow>
          )}
          <SwitchRow
            label="保存后启用"
            desc="启用后按上面调度自动执行;可随时停用(仅手动触发不受影响)。"
            checked={form.enabled}
            onChange={(v) => patchForm({ enabled: v })}
          />
          <div className="st-actions">
            <button type="button" className="ui-btn" onClick={() => setOpen(false)}>
              取消
            </button>
            <button
              type="button"
              className="ui-btn is-primary"
              disabled={saving}
              onClick={() => void save()}
            >
              {saving ? '保存中…' : '保存任务'}
            </button>
          </div>
        </SettingsCard>
      )}

      {history && (
        <div className="confirm-mask" onClick={() => setHistory(null)}>
          <div className="confirm-dialog rp-history" onClick={(e) => e.stopPropagation()}>
            <div className="confirm-title">运行历史 · {history.job.name}</div>
            {history.runs === null && <div className="st-hint">加载中…</div>}
            {history.runs !== null && history.runs.length === 0 && (
              <div className="st-hint">还没有运行记录(可点「立即执行」触发第一轮)</div>
            )}
            <div className="rp-run-list">
              {history.runs?.map((r) => (
                <div key={r.id} className="rp-run">
                  <div className="rp-run-line">
                    <span className={STATUS_CLS[r.status] ?? ''}>
                      {r.status === 'ok'
                        ? '成功'
                        : r.status === 'fail'
                          ? '失败'
                          : r.status === 'interrupted'
                            ? '中断'
                            : '执行中'}
                    </span>
                    <span>{fmtClock(r.startedAt)}</span>
                    <span>{r.trigger === 'manual' ? '手动' : '自动'}</span>
                    <span>新增 {r.added} 条</span>
                    <span>
                      会话 {r.sessionsOk} 成功{r.sessionsSkip ? `/${r.sessionsSkip} 跳过` : ''}
                    </span>
                    {r.durationMs !== undefined && r.durationMs !== null && (
                      <span>{(r.durationMs / 1000).toFixed(1)}s</span>
                    )}
                  </div>
                  {r.errors && <pre className="rp-run-err">{r.errors}</pre>}
                </div>
              ))}
            </div>
            <div className="confirm-actions">
              <button type="button" className="confirm-btn" onClick={() => setHistory(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
