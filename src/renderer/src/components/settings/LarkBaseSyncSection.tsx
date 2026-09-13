import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'
import { useWorkbenchStore } from '../../stores/workbench'
import { fmtStamp } from '../../../../shared/monitorMetrics'
import type { LarkBaseStatus, LarkBaseVerify, LarkSystemUpgrade } from '../../../../shared/types'
import { AdvancedBlock, FieldRow, PillRow, SettingsCard, StatusPill, SwitchRow } from './ui'

/**
 * 「议题同步到多维表格」+「议题证据明细同步」两张卡片（设置 → AI 助手）。
 *
 * 单独成组件的原因:这两张卡片自带 20+ 个状态与 15 个动作,原来和整个设置页挤在一个 2300 行组件里;
 * 它们彼此强相关(共用 baseStatus / baseBusy),对外只依赖「凭证刷新计数」一个 prop —— 正好是一块。
 */

/**
 * 链接脱敏：只保留域名与 token 首尾几位。
 * 用户不需要看见 app_token / table_id，排查时展开「高级信息」也有完整链接可复制。
 */
function maskBaseLink(link: string | undefined): string {
  const raw = (link ?? '').trim()
  if (!raw) return '未配置'
  const m = /^(https?:[/][/][^/]+)[/](?:base|bitable)[/]([A-Za-z0-9]+)/.exec(raw)
  if (!m) return raw.length > 12 ? raw.slice(0, 6) + '…' + raw.slice(-4) : raw
  const tok = m[2]
  return tok.length > 10 ? m[1] + '/base/' + tok.slice(0, 4) + '…' + tok.slice(-4) : raw
}

/** 同步历史里的 kind → 中文（证据明细是新增的一类，别只显示英文） */
const KIND_LABEL: Record<string, string> = {
  issue: '议题',
  reply: '影子回复',
  evidence: '证据明细',
  pull: '拉取同事改动'
}

export function LarkBaseSyncSection({ reloadKey }: { reloadKey: number }): React.JSX.Element {
  /** 账号作用域（同步是账号级的） */
  const wxid = useWorkbenchStore((s) => s.wxid)
  /** 议题 → 多维表格同步（Base） */
  const [baseStatus, setBaseStatus] = useState<LarkBaseStatus | null>(null)
  const [baseLink, setBaseLink] = useState('')
  const [baseBusy, setBaseBusy] = useState('')
  const [baseNotes, setBaseNotes] = useState<{ ok: boolean; lines: string[] } | null>(null)
  /** 预览结果(目标表/将新建列/类型冲突/主字段/回写能力) */
  const [basePreview, setBasePreview] = useState<LarkBaseVerify | null>(null)
  /** 列名映射表单(标准列名 → 目标表列名;空=用标准名) */
  const [baseFieldMap, setBaseFieldMap] = useState<Record<string, string>>({})
  /** 已配置时是否展开"配置类"按钮(预览/执行并建表/认领),避免与日常动作挤在一起 */
  const [baseReconfig, setBaseReconfig] = useState(false)
  /** 证据明细同步:三个上限的本地编辑值(保存后由 baseStatus.evidence 回读) */
  const [evDays, setEvDays] = useState('')
  const [evMax, setEvMax] = useState('')
  const [evChars, setEvChars] = useState('')
  /** 表格系统化升级:进行中的动作 + 结果报告 + 人员映射提示 */
  const [sysBusy, setSysBusy] = useState('')
  const [sysReport, setSysReport] = useState<LarkSystemUpgrade | null>(null)
  const [personFieldInput, setPersonFieldInput] = useState('')
  /** 手工映射文本（每行「称呼=open_id」） */
  const [personManual, setPersonManual] = useState('')
  const [personNotes, setPersonNotes] = useState('')
  /** 附件:单张上限(MB) / 每轮最多张数 */
  const [evMaxMB, setEvMaxMB] = useState('')
  const [evMaxUploads, setEvMaxUploads] = useState('')

  // 议题同步状态（含已保存的链接、上次同步结果）
  useEffect(() => {
    let alive = true
    void window.api?.cs?.lark
      ?.baseStatus()
      .then((res) => {
        if (!alive || !res?.ok || !res.status) return
        setBaseStatus(res.status)
        setBaseLink((cur) => cur || res.status?.link || '')
        if (res.status.fieldMap) setBaseFieldMap(res.status.fieldMap)
        const ev = res.status.evidence
        if (ev) {
          setEvDays((cur) => cur || String(ev.days))
          setEvMax((cur) => cur || String(ev.maxPerIssue))
          setEvChars((cur) => cur || String(ev.maxChars))
          setEvMaxMB((cur) => cur || String(ev.maxMediaMB))
          setEvMaxUploads((cur) => cur || String(ev.maxUploadsPerRound))
        }
        const person = res.status.person
        if (person) {
          setPersonFieldInput((cur) => cur || person.field)
          setPersonManual((cur) => cur || person.manual)
        }
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [reloadKey])

  /** 预览:只自检不改动 —— 先让用户看清"将发生什么"(目标表/将新建列/类型冲突/主字段/回写能力) */
  const previewBase = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.basePreview) return
    const link = baseLink.trim()
    if (!link) {
      setBaseNotes({ ok: false, lines: ['请先粘贴多维表格链接（…/base/xxxx）'] })
      return
    }
    setBaseBusy('preview')
    setBaseNotes(null)
    try {
      const res = await api.basePreview(link)
      setBasePreview(res)
      if (res.status) setBaseStatus(res.status)
      setBaseNotes({
        ok: !!res.ok,
        lines: [...(res.notes ?? []), ...(res.ok ? [] : [res.error ?? '预览失败'])]
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 认领目标表里已有的行(避免重复插入) */
  const claimBase = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseClaim || !wxid) return
    setBaseBusy('claim')
    setBaseNotes(null)
    try {
      const res = await api.baseClaim(wxid)
      if (res.status) setBaseStatus(res.status)
      const c = res.claimed
      setBaseNotes({
        ok: !!res.ok,
        lines: c
          ? [
              `扫描 ${c.scanned} 行:认领 ${c.claimed} · 已有映射 ${c.already} · 无法匹配 ${c.unmatched}`,
              ...(c.claimed > 0 ? ['下一轮同步会补齐这些行的程序列'] : []),
              ...(c.unmatched > 0
                ? ['无法匹配的行:目标表里存在但本地没有对应议题(可忽略或手动删除)']
                : [])
            ]
          : [res.error ?? '认领失败']
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 保存列名映射(本地标准列名 → 目标表实际列名) */
  const saveBaseFieldMap = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseFieldMap) return
    const map: Record<string, string> = {}
    for (const [k, v] of Object.entries(baseFieldMap)) {
      const name = (v ?? '').trim()
      if (name) map[k] = name
    }
    setBaseBusy('fieldmap')
    try {
      const res = await api.baseFieldMap(map)
      if (res.status) setBaseStatus(res.status)
      if (res.fieldMap) setBaseFieldMap(res.fieldMap)
      setBaseNotes({
        ok: !!res.ok,
        lines: [res.ok ? '列名映射已保存,下次同步生效' : (res.error ?? '保存失败')]
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 验证多维表格链接：读权限 + 写权限 + 自动建表建字段（一次说清） */
  const verifyBase = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseVerify) return
    const link = baseLink.trim()
    if (!link) {
      setBaseNotes({ ok: false, lines: ['请先粘贴多维表格链接（…/base/xxxx）'] })
      return
    }
    setBaseBusy('verify')
    setBaseNotes(null)
    try {
      const res = await api.baseVerify(link)
      if (res.status) setBaseStatus(res.status)
      setBaseNotes({
        ok: !!res.ok,
        lines: [...(res.notes ?? []), ...(res.ok ? [] : [res.error ?? '验证失败'])]
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 立即同步一批议题到多维表格 */
  const syncBaseNow = async (force: boolean): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseSync) return
    if (!wxid) {
      setBaseNotes({ ok: false, lines: ['还没连接微信账号：同步需要账号作用域'] })
      return
    }
    setBaseBusy('sync')
    setBaseNotes(null)
    try {
      const res = await api.baseSync(wxid, force)
      if (res.status) setBaseStatus(res.status)
      const r = res.result
      const pulled = res.pulled
      setBaseNotes({
        ok: !!res.ok,
        lines: r
          ? [
              `推送：扫描 ${r.scanned} · 新增 ${r.created} · 更新 ${r.updated} · 跳过 ${r.skipped}${r.failed ? ` · 失败 ${r.failed}` : ''}`,
              ...(pulled
                ? [
                    `拉取：应用到本地 ${pulled.applied} 条${pulled.skippedLocalWin ? ` · 冲突保留本地 ${pulled.skippedLocalWin}` : ''}${pulled.unmatched ? ` · 认不出 ${pulled.unmatched}` : ''}`
                  ]
                : []),
              ...(res.replies
                ? [
                    `影子记录：新增 ${res.replies.created} · 更新 ${res.replies.updated} · 跳过 ${res.replies.skipped}`
                  ]
                : []),
              ...(res.evidence && !res.evidence.error
                ? [
                    `证据明细：新增 ${res.evidence.created} · 更新 ${res.evidence.updated} · 跳过 ${res.evidence.skipped}${res.evidence.failed ? ` · 失败 ${res.evidence.failed}` : ''}`
                  ]
                : []),
              ...(r.error ? [r.error] : []),
              ...(pulled && !pulled.ok && pulled.error ? [pulled.error] : [])
            ]
          : [res.error ?? '同步失败']
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 只拉取同事在表格里改的状态/跟进人（不推送本地变更） */
  const pullBaseNow = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.basePull) return
    if (!wxid) {
      setBaseNotes({ ok: false, lines: ['还没连接微信账号'] })
      return
    }
    setBaseBusy('pull')
    setBaseNotes(null)
    try {
      const res = await api.basePull(wxid)
      if (res.status) setBaseStatus(res.status)
      const p = res.pulled
      setBaseNotes({
        ok: !!res.ok,
        lines: p
          ? [
              `读取 ${p.scanned} 行 · 应用到本地 ${p.applied}${p.skippedLocalWin ? ` · 冲突保留本地 ${p.skippedLocalWin}` : ''}${p.unmatched ? ` · 认不出 ${p.unmatched}` : ''}`
            ]
          : [res.error ?? '拉取失败']
      })
    } finally {
      setBaseBusy('')
    }
  }

  const patchBaseConfig = async (patch: {
    enabled?: boolean
    rawEvidence?: boolean
  }): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseConfig) return
    const res = await api.baseConfig(patch)
    if (res.status) setBaseStatus(res.status)
    if (!res.ok) setBaseNotes({ ok: false, lines: [res.error ?? '保存失败'] })
  }

  /** 证据明细:开关 + 三个上限(天数 / 每议题条数 / 每条字数) */
  const patchBaseEvidence = async (patch: {
    enabled?: boolean
    days?: number
    maxPerIssue?: number
    maxChars?: number
    media?: boolean
    maxMediaMB?: number
    maxUploadsPerRound?: number
  }): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseEvidence) return
    setBaseBusy('ev')
    setBaseNotes(null)
    try {
      const res = await api.baseEvidence(patch)
      if (res.status) setBaseStatus(res.status)
      if (res.evidence) {
        setEvDays(String(res.evidence.days))
        setEvMax(String(res.evidence.maxPerIssue))
        setEvChars(String(res.evidence.maxChars))
        setEvMaxMB(String(res.evidence.maxMediaMB))
        setEvMaxUploads(String(res.evidence.maxUploadsPerRound))
      }
      if (!res.ok) setBaseNotes({ ok: false, lines: [res.error ?? '保存证据配置失败'] })
      else if (patch.enabled === true && !res.evidence?.enabled) {
        setBaseNotes({ ok: false, lines: ['开关未生效,请重试'] })
      }
    } finally {
      setBaseBusy('')
    }
  }

  /** 创建/校验「议题证据」子表(含尝试建立关联字段) */
  const setupBaseEvidence = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseEvidenceSetup) return
    setBaseBusy('evsetup')
    setBaseNotes(null)
    try {
      const res = await api.baseEvidenceSetup()
      if (res.status) setBaseStatus(res.status)
      setBaseNotes({
        ok: !!res.ok,
        lines: res.ok
          ? [
              res.created ? '已新建「议题证据」子表' : '「议题证据」子表已存在',
              (res.fieldsAdded ?? []).length > 0
                ? `补齐字段:${(res.fieldsAdded ?? []).join('、')}`
                : '字段已齐',
              res.linkOk
                ? '已建立「关联议题」关联字段:点开议题即可看到证据明细'
                : '未建立关联字段(不影响同步):可在证据表按「议题ID」分组查看',
              ...(res.note ? [res.note] : [])
            ]
          : [res.error ?? '创建证据表失败']
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 清理孤儿证据行(议题已删除、远程行残留) */
  const cleanBaseEvidence = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseEvidenceClean) return
    setBaseBusy('evclean')
    setBaseNotes(null)
    try {
      const res = await api.baseEvidenceClean()
      if (res.status) setBaseStatus(res.status)
      setBaseNotes({
        ok: !!res.ok,
        lines: res.ok
          ? [res.removed > 0 ? `已清理 ${res.removed} 行孤儿证据` : '没有孤儿行']
          : [res.error ?? '清理失败']
      })
    } finally {
      setBaseBusy('')
    }
  }

  /** 一键把表格升级成「工单台」（幂等：重复点只显示「已存在」） */
  const upgradeSystem = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.baseSystemUpgrade) return
    setSysBusy('upgrade')
    setPersonNotes('')
    try {
      const res = await api.baseSystemUpgrade()
      setSysReport(res)
      const st = await api.baseStatus()
      if (st?.status) setBaseStatus(st.status)
      if (res.ok) toast.success('表格已升级（按钮/自动化/仪表盘见「手动清单」）')
      else toast.error(res.error ?? '部分步骤失败，详见结果')
    } finally {
      setSysBusy('')
    }
  }

  /** 复制「只能手动点」的清单 */
  const copyManualSteps = async (): Promise<void> => {
    const list = sysReport?.manual ?? []
    if (list.length === 0) return
    try {
      await navigator.clipboard.writeText(list.map((s, i) => i + 1 + '. ' + s).join('\n'))
      toast.success('已复制手动清单')
    } catch {
      toast.error('复制失败：可手动选中文本')
    }
  }

  /** 人员列开关 / 列名 */
  const patchPerson = async (patch: {
    enabled?: boolean
    field?: string
    manual?: string
  }): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.basePerson) return
    const res = await api.basePerson(patch)
    if (res.status) setBaseStatus(res.status)
    if (res.person) setPersonFieldInput(res.person.field)
    if (!res.ok) toast.error(res.error ?? '保存人员列配置失败')
    else if (patch.enabled === true) {
      setPersonNotes(
        '已开启：点「一键升级表格」会建出人员列；先「刷新人员映射」把称呼对上飞书账号。'
      )
    }
  }

  /** 刷新「称呼 → open_id」映射 */
  const refreshPerson = async (): Promise<void> => {
    const api = window.api?.cs?.lark
    if (!api?.basePersonRefresh) return
    setSysBusy('person')
    setPersonNotes('')
    try {
      const res = await api.basePersonRefresh()
      if (res.status) setBaseStatus(res.status)
      if (!res.ok) {
        setPersonNotes(`解析失败：${res.error ?? '未知错误'}`)
        toast.error('人员映射解析失败')
        return
      }
      setPersonNotes(
        `已解析 ${res.mapped} 人${res.names.length > 0 ? '：' + res.names.slice(0, 8).join('、') + (res.names.length > 8 ? '…' : '') : ''}${res.hint ? ' · ' + res.hint : ''}`
      )
      toast.success(`人员映射已刷新：${res.mapped} 人`)
    } finally {
      setSysBusy('')
    }
  }
  /** 复制多维表格完整链接（高级信息里给排查/转给同事用） */
  const copyBaseLink = async (): Promise<void> => {
    const link = (baseStatus?.link ?? '').trim()
    if (!link) return
    try {
      await navigator.clipboard.writeText(link)
      toast.success('已复制多维表格链接')
    } catch {
      toast.error('复制失败：展开高级信息后可手动选中复制')
    }
  }

  return (
    <>
      <SettingsCard
        title="议题同步到多维表格(飞书 Base)"
        desc="把群问题（议题）单向推到飞书多维表格，同事在手机/电脑上就能看到与处理。先「验证并建表」（会自动创建「议题」「数字员工回复」两张表与字段），再打开同步开关。默认只推标题/摘要，不推聊天原文。"
      >
        {/* 状态用胶囊表达:一眼看清「连上没 / 自动同步开没开 / 推了多少」 */}
        <PillRow>
          <StatusPill
            tone={baseStatus?.configured ? 'ok' : 'off'}
            text={
              baseStatus?.configured
                ? baseStatus.baseName
                  ? `已连接「${baseStatus.baseName}」`
                  : '已连接多维表格'
                : '未连接多维表格'
            }
          />
          <StatusPill
            tone={baseStatus?.enabled ? 'ok' : 'off'}
            text={baseStatus?.enabled ? '自动同步已开' : '自动同步已关'}
            title="每 2 分钟自动把有变更的议题推到多维表格"
          />
          {baseStatus?.issuesTableName ? (
            <StatusPill text={`议题表「${baseStatus.issuesTableName}」`} />
          ) : null}
          {baseStatus?.mappedIssues ? (
            <StatusPill text={`已推 ${baseStatus.mappedIssues} 条议题`} />
          ) : null}
          {baseStatus?.configured ? (
            <StatusPill
              tone={baseStatus.canWriteBack ? 'ok' : 'warn'}
              text={baseStatus.canWriteBack ? '同事可回写' : '仅单向推送'}
              title={
                baseStatus.canWriteBack
                  ? '同事在表格里改「状态 / 跟进人 / 处理备注」会同步回本地'
                  : '目标表缺「状态/跟进人/处理备注」列，同事的改动不会回到本地（补齐后自动开启）'
              }
            />
          ) : null}
          {baseStatus?.lastResult?.failed ? (
            <StatusPill
              tone="bad"
              text={`上次失败 ${baseStatus.lastResult.failed} 条`}
              title={baseStatus.lastResult.error ?? ''}
            />
          ) : null}
        </PillRow>
        <div className="st-hint">{baseStatus === null ? '读取同步状态中…' : baseStatus.hint}</div>
        {/* 链接只在「未配置」或点了「重新配置」时出现:配好之后用户不需要再看到这串 token */}
        {(!baseStatus?.configured || baseReconfig) && (
          <FieldRow label="多维表格链接">
            <input
              className="st-input"
              value={baseLink}
              onChange={(e) => setBaseLink(e.target.value)}
              placeholder="粘贴多维表格分享链接（…/base/xxxxx）"
            />
          </FieldRow>
        )}
        <div className="sf-actions-split">
          {baseStatus?.configured && !baseReconfig ? (
            <>
              <button
                type="button"
                className="st-btn"
                disabled={baseBusy !== ''}
                onClick={() => void syncBaseNow(false)}
              >
                {baseBusy === 'sync' ? '同步中…' : '立即同步'}
              </button>
              <button
                type="button"
                className="st-btn ghost"
                disabled={baseBusy !== ''}
                onClick={() => void syncBaseNow(true)}
                title="忽略上次同步时间，把所有议题核对一遍"
              >
                全量核对
              </button>
              <button
                type="button"
                className="st-btn ghost"
                disabled={baseBusy !== ''}
                onClick={() => void pullBaseNow()}
                title="只把同事在表格里改的状态/跟进人拉回本地（不推送本地变更）"
              >
                {baseBusy === 'pull' ? '拉取中…' : '拉取同事改动'}
              </button>
              <button
                type="button"
                className="st-btn ghost is-end"
                onClick={() => setBaseReconfig(true)}
                title="换一个多维表格 / 换目标表 / 重新自检字段"
              >
                重新配置
              </button>
            </>
          ) : (
            <>
              <button
                type="button"
                className="st-btn ghost"
                disabled={baseBusy !== ''}
                onClick={() => void previewBase()}
                title="只自检、不改动：先看目标表、将新建哪些列、有没有类型冲突"
              >
                {baseBusy === 'preview' ? '预览中…' : '预览（不改动）'}
              </button>
              <button
                type="button"
                className="st-btn"
                disabled={baseBusy !== ''}
                onClick={() => void verifyBase()}
                title="按链接执行：用你指定的表（或新建「议题」表）并补齐字段，然后写一条测试记录验证写权限"
              >
                {baseBusy === 'verify' ? '执行中…' : '执行并建表'}
              </button>
              {baseReconfig && (
                <button
                  type="button"
                  className="st-btn ghost is-end"
                  onClick={() => setBaseReconfig(false)}
                >
                  取消
                </button>
              )}
            </>
          )}
        </div>
        <SwitchRow
          label="定时同步（每 2 分钟）"
          desc="打开后自动把有变更的议题推到多维表格；关闭则只能手动同步"
          checked={!!baseStatus?.enabled}
          onChange={(v) => void patchBaseConfig({ enabled: v })}
        />
        <SwitchRow
          label="影子记录附带更长的聊天原文"
          desc="默认关闭。打开后「数字员工回复」表的「触发消息」列会带上更长上下文（120 → 500 字），便于同事对照话术；只影响这一列，不等于推送证据明细（见下方「议题证据明细」卡片）"
          checked={!!baseStatus?.rawEvidence}
          onChange={(v) => void patchBaseConfig({ rawEvidence: v })}
        />
        <div className="st-hint">
          证据明细（客户原话）默认不推：见下方「议题证据明细同步（子表）」卡片，需单独开启。
        </div>
        {basePreview && (
          <div className="st-hint">
            <b>目标表：</b>
            {basePreview.issuesTableName ?? '-'}
            {basePreview.issuesTableCreated ? '（本次新建）' : ''}
            {basePreview.appName ? ` · Base「${basePreview.appName}」` : ''}
            <br />
            <b>现有列：</b>
            {(basePreview.existingFields ?? []).join('、') || '(空表)'}
            <br />
            <b>将新建：</b>
            {(basePreview.missingFields ?? []).join('、') || '无（字段已齐）'}
            {basePreview.primaryField ? (
              <>
                <br />
                <b>主字段：</b>
                {basePreview.primaryField}（会把问题标题写进这一列）
              </>
            ) : null}
            <br />
            <b>同事回写：</b>
            {basePreview.canWriteBack
              ? '支持（状态 / 跟进人 / 处理备注 三列齐全）'
              : '暂不支持（缺状态/跟进人/处理备注列，执行后会补齐）'}
            {(basePreview.typeConflicts ?? []).length > 0 && (
              <>
                <br />
                <span className="st-bad">
                  ⚠ 类型不符（不改动，写入可能失败）：
                  {(basePreview.typeConflicts ?? [])
                    .map((c) => `${c.name}（现有 ${c.got} / 需要 ${c.want}）`)
                    .join('、')}
                </span>
              </>
            )}
          </div>
        )}
        {baseNotes && (
          <div className="st-ai-test">
            <span className={baseNotes.ok ? 'st-ok' : 'st-bad'}>
              {(baseNotes.ok ? '✓ ' : '✗ ') + baseNotes.lines.join('；')}
            </span>
          </div>
        )}
        {/* 排查类信息默认收起:用户平时不需要看链接、列名映射与权限细节 */}
        <AdvancedBlock
          label={baseStatus?.configured ? '高级信息（链接 / 表结构 / 历史）' : '高级信息（排查用）'}
        >
          {baseStatus?.configured && (
            <>
              <FieldRow label="表格链接">
                <input className="st-input" value={maskBaseLink(baseStatus.link)} readOnly />
                <button
                  type="button"
                  className="st-btn ghost"
                  onClick={() => void copyBaseLink()}
                  title="复制完整链接（发给同事或排查时用）"
                >
                  复制
                </button>
              </FieldRow>
              <div className="st-hint">
                {`Base「${baseStatus.baseName || '未读取到名称'}」 · 议题表「${baseStatus.issuesTableName || '议题'}」 · 上次同步 ${fmtStamp(baseStatus.lastAt)}`}
              </div>
              <div className="sf-actions-split">
                <button
                  type="button"
                  className="st-btn ghost"
                  disabled={baseBusy !== ''}
                  onClick={() => void claimBase()}
                  title="目标表里已有行时，按「议题ID」与本地议题对上，避免同步时重复插入"
                >
                  {baseBusy === 'claim' ? '认领中…' : '认领既有行（表里已有数据时用）'}
                </button>
              </div>
            </>
          )}
          <div className="st-hint">
            权限前提：开放平台给应用开通多维表格读写(bitable:app)并发布版本，再把应用加为该 Base
            的协作者（打开表格 → 分享 → 添加协作者 → 选本应用
            →「可编辑」）。只读权限能读表但写不进去， 「预览 / 执行并建表」会明确告诉你是哪种情况。
          </div>

          {/* 一键把表格升级成「工单台」:建列 + 建视图 + 证据关联升双向(幂等) */}
          <div className="st-subtitle">表格系统化（工单号 / 超时预警 / 看板 / 表单）</div>
          <div className="st-hint">
            {'一键给议题表加「工单号、等待时长、超时预警、标签」4 列，给三个表建看板/表单/画册视图，' +
              '并把证据关联升级成双向（议题行上就能看到全部证据）。幂等：重复点只显示「已存在」。'}
          </div>
          <div className="sf-actions-split">
            <button
              type="button"
              className="st-btn"
              disabled={sysBusy !== '' || !baseStatus?.configured}
              onClick={() => void upgradeSystem()}
              title="只新增：不动你已有的列与数据；按钮列/仪表盘/自动化飞书没开放接口，会列在结果里让你手动点"
            >
              {sysBusy === 'upgrade' ? '升级中…' : '一键升级表格'}
            </button>
            {sysReport && sysReport.manual.length > 0 && (
              <button
                type="button"
                className="st-btn ghost is-end"
                onClick={() => void copyManualSteps()}
                title="复制「需要手动点」的清单（按钮列/自动化/仪表盘/日期格式）"
              >
                复制手动清单
              </button>
            )}
          </div>
          {sysReport && (
            <div className="st-hint">
              {sysReport.ok ? '✓ 升级完成' : `✗ ${sysReport.error ?? '部分步骤失败'}`}
              <br />
              {sysReport.steps.map((s, i) => (
                <div key={i}>
                  {s.action === 'created' ? '＋ ' : s.action === 'skipped' ? '· ' : '⚠ '}
                  {s.label}
                  {s.detail ? `（${s.detail}）` : ''}
                </div>
              ))}
            </div>
          )}

          {/* 人员列:真正的飞书成员(能 @提醒、能被自动化识别) */}
          <div className="st-subtitle">处理人（飞书成员）</div>
          <SwitchRow
            label="把「跟进人」也写成飞书人员"
            desc="打开后，Base 会多一列人员字段（默认叫「处理人」），写的是飞书成员，可以 @提醒、也能被自动化识别。需要先「刷新人员映射」把同事称呼对上飞书账号；对不上就留空，绝不猜人。"
            checked={!!baseStatus?.person?.enabled}
            onChange={(v) => void patchPerson({ enabled: v })}
          />
          {baseStatus?.person?.enabled && (
            <>
              <FieldRow label="人员列列名">
                <input
                  className="st-input sm"
                  value={personFieldInput}
                  onChange={(e) => setPersonFieldInput(e.target.value)}
                  onBlur={() => void patchPerson({ field: personFieldInput })}
                  placeholder="处理人"
                />
              </FieldRow>
              <div className="sf-actions-split">
                <button
                  type="button"
                  className="st-btn ghost"
                  disabled={sysBusy !== ''}
                  onClick={() => void refreshPerson()}
                  title="按应用可见的通讯录解析「称呼 → open_id」，一天刷一次就够"
                >
                  {sysBusy === 'person' ? '解析中…' : '刷新人员映射'}
                </button>
              </div>
              <div className="st-hint">
                {`已解析 ${baseStatus.person.mapped} 人${baseStatus.person.mappedAt ? ` · 上次 ${fmtStamp(baseStatus.person.mappedAt)}` : ' · 还没解析过'}`}
              </div>
              <div className="st-subtitle">手工映射（通讯录读不到姓名时用）</div>
              <div className="st-hint">
                {
                  '每行一条：称呼=open_id（例如 陈西西=ou_xxx）。手工写的优先于自动解析，保存后立刻生效。'
                }
              </div>
              <textarea
                className="st-input st-ta"
                value={personManual}
                onChange={(e) => setPersonManual(e.target.value)}
                onBlur={() => void patchPerson({ manual: personManual })}
                placeholder={'陈西西=ou_xxxxxxxx\n黄巧=ou_yyyyyyyy'}
                rows={3}
              />
            </>
          )}
          {personNotes && <div className="st-hint">{personNotes}</div>}

          {/* 列名映射:目标表列名与标准列不同时,在这里对齐(留空=用标准名) */}
          <div className="st-subtitle">列名映射（可选：你的表列名与标准列不同时填写）</div>
          <div className="st-grid" style={{ marginTop: 6 }}>
            {[
              '议题ID',
              '客户群',
              '类型',
              '严重度',
              '标题',
              '摘要',
              '状态',
              '跟进人',
              '处理备注',
              '首现时间',
              '最近更新',
              '证据条数'
            ].map((name) => (
              <FieldRow key={name} label={name}>
                <input
                  className="st-input sm"
                  value={baseFieldMap[name] ?? ''}
                  placeholder={name}
                  onChange={(e) => setBaseFieldMap((m) => ({ ...m, [name]: e.target.value }))}
                />
              </FieldRow>
            ))}
            <div className="st-actions">
              <button
                type="button"
                className="st-btn"
                disabled={baseBusy !== ''}
                onClick={() => void saveBaseFieldMap()}
              >
                {baseBusy === 'fieldmap' ? '保存中…' : '保存列名映射'}
              </button>
            </div>
          </div>

          {/* 同步历史:最近 8 轮,便于排查"为什么没同步" */}
          {(baseStatus?.history ?? []).length > 0 && (
            <>
              <div className="st-subtitle">
                最近同步记录（{baseStatus?.history?.length ?? 0} 轮）
              </div>
              <div>
                {(baseStatus?.history ?? []).slice(0, 8).map((h, i) => (
                  <div key={i}>
                    {KIND_LABEL[String(h.kind ?? '')] ?? String(h.kind ?? '')} ·{' '}
                    {fmtStamp(Number(h.at ?? 0))} ·{' '}
                    {h.error
                      ? `失败:${String(h.error).slice(0, 80)}`
                      : h.kind === 'pull'
                        ? `读 ${String(h.scanned ?? 0)} · 采纳 ${String(h.applied ?? 0)} · 冲突保留本地 ${String(h.skippedLocalWin ?? 0)}${h.note ? ` · ${String(h.note)}` : ''}`
                        : `扫 ${String(h.scanned ?? 0)} · 新增 ${String(h.created ?? 0)} · 更新 ${String(h.updated ?? 0)} · 跳过 ${String(h.skipped ?? 0)}${Number(h.skippedFields ?? 0) > 0 ? ` · ⚠ 因列类型不符跳过 ${String(h.skippedFields)} 次` : ''}${Number(h.mediaUploaded ?? 0) + Number(h.mediaCached ?? 0) > 0 ? ` · 附件 ${Number(h.mediaUploaded ?? 0)} 条(素材复用 ${Number(h.mediaCached ?? 0)})` : ''}`}
                  </div>
                ))}
              </div>
            </>
          )}
          {baseStatus?.pullNote && (
            <div className="st-hint">最近一轮拉取：{baseStatus.pullNote}</div>
          )}
        </AdvancedBlock>
      </SettingsCard>

      {/* 证据明细:客户原话单独一张子表(默认关闭) */}
      <SettingsCard
        title="议题证据明细同步（子表）"
        desc="把每个议题下的消息逐条推到「议题证据」子表（一行一条），同事在 Base 里能按议题ID/时间分组筛选，看清客户到底说了什么。默认关闭：客户原话属于敏感内容，请确认可外发后再开。"
      >
        {/* 状态用胶囊:开没开、推了多少、还剩多少、附件开没开 */}
        <PillRow>
          <StatusPill
            tone={baseStatus?.evidence?.enabled ? 'ok' : 'off'}
            text={baseStatus?.evidence?.enabled ? '证据明细已开启' : '证据明细未开启'}
          />
          {baseStatus?.evidence ? (
            <StatusPill
              text={`近 ${baseStatus.evidence.days} 天 · 每议题 ≤ ${baseStatus.evidence.maxPerIssue} 条 · 每条 ≤ ${baseStatus.evidence.maxChars} 字`}
            />
          ) : null}
          <StatusPill text={`已推 ${baseStatus?.mappedEvidence ?? 0} 条`} />
          {baseStatus?.pendingEvidence ? (
            <StatusPill tone="warn" text={`待推 ${baseStatus.pendingEvidence} 条`} />
          ) : (
            <StatusPill tone="ok" text="已追平" />
          )}
          <StatusPill
            tone={baseStatus?.evidence?.media ? 'ok' : 'off'}
            text={baseStatus?.evidence?.media ? '图片附件已开' : '图片附件未开'}
            title={
              baseStatus?.evidence?.media
                ? '图片证据会解密后上传到「证据图」列'
                : '只推文字，图片写「[图片]」占位'
            }
          />
        </PillRow>
        {!baseStatus?.evidence?.tableId && baseStatus?.evidence && (
          <div className="st-hint">
            {
              '证据子表还没创建：打开下面的开关后会自动新建并补齐字段，也可以先点「创建 / 校验证据表」。'
            }
          </div>
        )}
        <SwitchRow
          label="推送证据明细（客户原话）"
          desc="打开后把证据原文写入飞书表格（范围/条数/字数上限在下方「高级信息」里调）；关闭时一条都不推。"
          checked={!!baseStatus?.evidence?.enabled}
          onChange={(v) => void patchBaseEvidence({ enabled: v })}
        />
        <div className="st-hint">
          {'每个议题取「首现 1 条 + 最新若干条」，不是全量搬；上限在「高级信息」里调。'}
        </div>
        {/* 附件:客户原图比文字更敏感,单独一个开关(默认关) */}
        <SwitchRow
          label="上传证据图片（附件）"
          desc="默认关闭。打开后把图片证据解密出的原图上传到「证据图」附件列，同事在 Base 里能直接看图、可下载；同一张图只上传一次。视频/文件消息本地没有 md5，仍只写占位标记。"
          checked={!!baseStatus?.evidence?.media}
          onChange={(v) => void patchBaseEvidence({ media: v })}
        />

        {/* 隐私:比普通提示更醒目,因为这一条一旦打开就是客户原文外发 */}
        <div className="sf-note-warn">
          <b>隐私提醒：</b>
          开启后客户在群里的原话（含图片原图，若也开了附件）会写入飞书多维表格。
          建议先在证据表里单独设权限/视图（例如只给处理同事），对敏感业务（手机号、住址、订单号）
          收紧范围天数，或直接保持关闭。
        </div>
        {baseStatus?.lastEvidence && (
          <div className="st-hint">
            {`上次证据同步 ${fmtStamp(baseStatus.lastEvidence.at)}：`}
            {baseStatus.lastEvidence.error
              ? baseStatus.lastEvidence.error
              : `扫 ${baseStatus.lastEvidence.scanned} · 新增 ${baseStatus.lastEvidence.created} · 更新 ${baseStatus.lastEvidence.updated} · 跳过 ${baseStatus.lastEvidence.skipped}${baseStatus.lastEvidence.failed ? ` · 失败 ${baseStatus.lastEvidence.failed}` : ''}${baseStatus.lastEvidence.mediaUploaded || baseStatus.lastEvidence.mediaCached ? ` · 附件写 ${baseStatus.lastEvidence.mediaUploaded ?? 0} 条（复用素材 ${baseStatus.lastEvidence.mediaCached ?? 0} 张）` : ''}${baseStatus.lastEvidence.mediaFailed ? ` · 附件失败 ${baseStatus.lastEvidence.mediaFailed}` : ''}`}
          </div>
        )}

        {/* 上限、表结构与清理都收进高级信息:首屏只留「开关 + 状态 + 一键动作」 */}
        <AdvancedBlock label="高级信息（上限设置 / 表结构 / 清理）">
          <div className="st-subtitle">推送上限</div>
          <div className="st-grid">
            <FieldRow label="范围（天）">
              <input
                className="st-input sm"
                value={evDays}
                onChange={(e) => setEvDays(e.target.value)}
                onBlur={() => void patchBaseEvidence({ days: Number(evDays) })}
                placeholder="7"
              />
            </FieldRow>
            <FieldRow label="每议题最多（条）">
              <input
                className="st-input sm"
                value={evMax}
                onChange={(e) => setEvMax(e.target.value)}
                onBlur={() => void patchBaseEvidence({ maxPerIssue: Number(evMax) })}
                placeholder="20"
              />
            </FieldRow>
            <FieldRow label="每条截断（字）">
              <input
                className="st-input sm"
                value={evChars}
                onChange={(e) => setEvChars(e.target.value)}
                onBlur={() => void patchBaseEvidence({ maxChars: Number(evChars) })}
                placeholder="200"
              />
            </FieldRow>
          </div>
          {baseStatus?.evidence?.media && (
            <>
              <div className="st-subtitle">图片附件</div>
              <div className="st-grid">
                <FieldRow label="单张上限（MB）">
                  <input
                    className="st-input sm"
                    value={evMaxMB}
                    onChange={(e) => setEvMaxMB(e.target.value)}
                    onBlur={() => void patchBaseEvidence({ maxMediaMB: Number(evMaxMB) })}
                    placeholder="10"
                  />
                </FieldRow>
                <FieldRow label="每轮最多（张）">
                  <input
                    className="st-input sm"
                    value={evMaxUploads}
                    onChange={(e) => setEvMaxUploads(e.target.value)}
                    onBlur={() =>
                      void patchBaseEvidence({ maxUploadsPerRound: Number(evMaxUploads) })
                    }
                    placeholder="20"
                  />
                </FieldRow>
              </div>
              <div className="st-hint">
                {'上传前先解密到本地缓存（与监控页看图同一条链路），再传素材、写附件列；'}
                {'超过单张上限的直接跳过（保留「[图片]」占位），失败的下一轮自动重试。'}
              </div>
            </>
          )}
          <div className="st-subtitle">表格结构</div>
          <div className="st-hint">
            {`证据子表「议题证据」${baseStatus?.evidence?.tableId ? '已创建' : '尚未创建'} · 已上传素材 ${baseStatus?.mappedMedia ?? 0} 张 · 已写附件 ${baseStatus?.attachedEvidence ?? 0} 条`}
          </div>
          <div className="sf-actions-split">
            <button
              type="button"
              className="st-btn ghost"
              disabled={baseBusy !== '' || !baseStatus?.configured}
              onClick={() => void setupBaseEvidence()}
              title="在同一个 Base 里创建「议题证据」子表并补齐字段（已存在则只补字段）；会尝试建立与议题表的关联字段，失败不影响同步"
            >
              {baseBusy === 'evsetup' ? '处理中…' : '创建 / 校验证据表'}
            </button>
            <button
              type="button"
              className="st-btn ghost"
              disabled={baseBusy !== '' || !baseStatus?.configured}
              onClick={() => void cleanBaseEvidence()}
              title="对比远程「证据ID」与本地记录，删掉议题已删除后残留的孤儿行"
            >
              {baseBusy === 'evclean' ? '清理中…' : '清理孤儿行'}
            </button>
          </div>
          <div className="st-hint">
            Base 侧建议：在「议题证据」表建两个视图——「按 议题ID 分组」（分组 + 按时间升序）
            和「今日新增」（筛选 时间 = 今天），同事排查看证据会快很多。
          </div>
        </AdvancedBlock>
      </SettingsCard>
    </>
  )
}
