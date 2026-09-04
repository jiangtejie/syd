import { useEffect, useMemo, useState } from 'react'
import type { SkillInstallInfo, SkillPackageItem } from '../../../shared/types'
import { toast } from '../stores/toast'
import './skills.css'

/**
 * 技能管理页(卡片式布局)。
 * - 「内置软件能力」:分层渐进式能力(L2,只读)卡片,停用开关直接生效;
 * - 「技能包」:第三方声明式技能卡片网格,点击卡片查看详情(描述/作者/安装时间);
 * - 安装 = 选择含 skill.json 的目录 → 校验并展示能力清单与风险 → 确认安装。
 */

const skillApi = window.api?.cs?.skill

interface SoftwareCapRow {
  name: string
  oneLine: string
  when: string
  needsWx: boolean
  disabled: boolean
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  const p = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export default function SkillsPage(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillPackageItem[] | null>(null)
  const [softCaps, setSoftCaps] = useState<SoftwareCapRow[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const [pending, setPending] = useState<SkillInstallInfo | null>(null)
  const [pendingDir, setPendingDir] = useState('')

  const load = async (): Promise<void> => {
    const res = await skillApi?.list().catch(() => null)
    if (res?.ok && res.skills) setSkills(res.skills as SkillPackageItem[])
    else setSkills([])
  }

  const loadSoftCaps = async (): Promise<void> => {
    const res = await window.api?.cs?.cap?.software().catch(() => null)
    if (res?.ok && res.caps) setSoftCaps(res.caps as SoftwareCapRow[])
    else setSoftCaps([])
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取技能列表(全仓同款模式)
    void load()
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取内置软件能力(全仓同款模式)
    void loadSoftCaps()
  }, [])

  const active = useMemo(() => skills?.find((s) => s.id === selected) ?? null, [skills, selected])

  const pickAndInspect = async (): Promise<void> => {
    const dir = await window.api?.cs?.dialog?.pickDirectory('选择技能包目录(需含 skill.json)')
    if (!dir?.ok || !dir.path) return
    setInstalling(true)
    try {
      const res = await skillApi?.inspect(dir.path).catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '检查失败')
        return
      }
      setPending(res.info as SkillInstallInfo)
      setPendingDir(dir.path)
    } finally {
      setInstalling(false)
    }
  }

  const confirmInstall = async (): Promise<void> => {
    if (!pendingDir) return
    setInstalling(true)
    try {
      const res = await skillApi?.install(pendingDir).catch(() => null)
      if (!res?.ok) {
        toast.error((res as { error?: string } | null)?.error || '安装失败')
        return
      }
      toast.success(`技能「${pending?.name}」已安装(新对话默认挂载)`)
      setPending(null)
      setPendingDir('')
      await load()
    } finally {
      setInstalling(false)
    }
  }

  const toggle = async (s: SkillPackageItem): Promise<void> => {
    const res = await skillApi?.toggle(s.id, !s.enabled).catch(() => null)
    if (res?.ok) {
      setSkills((prev) =>
        (prev ?? []).map((x) => (x.id === s.id ? { ...x, enabled: !s.enabled } : x))
      )
    } else {
      toast.error((res as { error?: string } | null)?.error || '操作失败')
    }
  }

  const remove = async (s: SkillPackageItem): Promise<void> => {
    if (!window.confirm(`卸载技能「${s.name}」v${s.version}?`)) return
    const res = await skillApi?.remove(s.id).catch(() => null)
    if (res?.ok) {
      toast.success('已卸载')
      if (selected === s.id) setSelected(null)
      await load()
    } else {
      toast.error((res as { error?: string } | null)?.error || '卸载失败')
    }
  }

  const toggleSoftCap = async (c: SoftwareCapRow): Promise<void> => {
    const next = !c.disabled
    const res = await window.api?.cs?.cap?.setSoftware(c.name, next).catch(() => null)
    if (res?.ok) {
      setSoftCaps((prev) =>
        (prev ?? []).map((x) => (x.name === c.name ? { ...x, disabled: !next } : x))
      )
    } else {
      toast.error((res as { error?: string } | null)?.error || '操作失败')
    }
  }

  return (
    <div className="page-scroll skills-page">
      <div className="skills-head">
        <h2 className="page-title">技能</h2>
        <button
          type="button"
          className="st-btn"
          disabled={installing}
          onClick={() => void pickAndInspect()}
        >
          {installing ? '检查中…' : '＋ 安装技能'}
        </button>
      </div>
      <p className="skills-intro">
        能力分层渐进式加载:核心(L0)常驻,内置软件能力与外部技能按需「挂载」进会话;第三方技能包 tool
        类 = HTTP 白名单执行器(调用需人工确认),knowledge 类 = 受控知识注入。仅接受 manifest,
        不含可执行代码,请只安装可信来源。
      </p>

      {pending && (
        <div className="skills-pending">
          <div className="skills-pending-title">
            确认安装「{pending.name}」v{pending.version}({pending.kind === 'tool' ? '工具' : '知识'}
            )
          </div>
          <div className="skills-pending-desc">{pending.description}</div>
          <ul className="skills-caps">
            {pending.capabilities.map((c, i) => (
              <li key={i}>{c}</li>
            ))}
          </ul>
          <div className="skills-pending-meta">hash: {pending.hash} · 校验通过 · 来源:本地目录</div>
          <div className="skills-pending-ops">
            <button type="button" className="st-btn ghost" onClick={() => setPending(null)}>
              取消
            </button>
            <button
              type="button"
              className="st-btn"
              disabled={installing}
              onClick={() => void confirmInstall()}
            >
              {installing ? '安装中…' : '确认安装'}
            </button>
          </div>
        </div>
      )}

      {/* ── 内置软件能力(卡片) ── */}
      {softCaps !== null && (
        <section className="skills-sec">
          <div className="skills-sec-head">
            <h3>内置软件能力</h3>
            <span className="skills-sec-tag">L2 · 只读 · 对话内按需挂载</span>
            <p className="skills-sec-hint">
              AI 通过 list_capabilities 查看目录、mount_capability 挂载后使用;停用后目录不再出现。
              标「需账号」的能力仅绑定微信账号的会话可用。
            </p>
          </div>
          {softCaps.length === 0 ? (
            <div className="skills-empty">暂无内置软件能力。</div>
          ) : (
            <div className="skills-grid">
              {softCaps.map((c) => (
                <div key={c.name} className={`skill-card${c.disabled ? ' is-off' : ''}`}>
                  <div className="skill-card-top">
                    <b>{c.name}</b>
                    <span className={`skill-kind ${c.disabled ? 'off' : ''}`}>
                      {c.disabled ? '已停用' : '可用'}
                    </span>
                    {c.needsWx && <span className="skill-kind wx">需账号</span>}
                  </div>
                  <div className="skill-card-desc">{c.oneLine}</div>
                  {c.when && <div className="skill-card-when">适用:{c.when}</div>}
                  <div className="skill-card-ops">
                    <button
                      type="button"
                      className="st-btn ghost sm"
                      onClick={() => void toggleSoftCap(c)}
                    >
                      {c.disabled ? '启用' : '停用'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ── 第三方技能包(卡片网格) ── */}
      <section className="skills-sec">
        <div className="skills-sec-head">
          <h3>技能包</h3>
          {skills !== null && <span className="skills-sec-count">{skills.length} 个已安装</span>}
          <p className="skills-sec-hint">
            启用后新对话会将其加入默认挂载;挂载集为会话级,对话中可让 AI 查看目录、挂载或卸载。
            点击卡片查看详情。
          </p>
        </div>
        {skills === null ? (
          <div className="skills-empty">加载中…</div>
        ) : skills.length === 0 ? (
          <div className="skills-empty">
            暂无技能。选择包含 skill.json 的目录进行安装(可来自第三方分发,下载解压后选择)。
          </div>
        ) : (
          <div className="skills-grid">
            {skills.map((s) => (
              <div
                key={s.id}
                className={`skill-card${selected === s.id ? ' is-active' : ''}`}
                onClick={() => setSelected(s.id)}
                title="点击查看详情"
              >
                <div className="skill-card-top">
                  <b>{s.name}</b>
                  <span className={`skill-kind ${s.kind}`}>
                    {s.kind === 'tool' ? '工具' : '知识'}
                  </span>
                  <span className="skill-version">v{s.version}</span>
                  {s.enabled ? (
                    <span className="skill-on">生效</span>
                  ) : (
                    <span className="skill-off">停用</span>
                  )}
                </div>
                <div className="skill-card-desc">{s.description}</div>
                <div className="skill-card-meta">
                  <span>{s.author ? `作者:${s.author}` : '未署名'}</span>
                  <span>{fmtDate(s.createdAt)}</span>
                </div>
                <div className="skill-card-ops" onClick={(e) => e.stopPropagation()}>
                  <button type="button" className="st-btn ghost sm" onClick={() => void toggle(s)}>
                    {s.enabled ? '停用' : '启用'}
                  </button>
                  <button
                    type="button"
                    className="st-btn ghost danger sm"
                    onClick={() => void remove(s)}
                  >
                    卸载
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {/* 选中卡片详情条 */}
        {active && (
          <div className="skills-detailbar">
            <div className="skills-detailbar-title">
              {active.name} <span className="skill-version">v{active.version}</span>
            </div>
            <div className="skills-detailbar-desc">{active.description}</div>
            <div className="skills-detailbar-kv">
              <span>类型</span>
              <span>{active.kind === 'tool' ? '工具(HTTP 执行器,需确认)' : '知识(受控注入)'}</span>
              <span>作者</span>
              <span>{active.author ?? '未署名'}</span>
              <span>状态</span>
              <span>{active.enabled ? '生效(新对话默认挂载)' : '已停用'}</span>
              <span>安装于</span>
              <span>{new Date(active.createdAt).toLocaleString()}</span>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
