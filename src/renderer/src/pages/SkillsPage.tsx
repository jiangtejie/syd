import { useEffect, useMemo, useState } from 'react'
import type { SkillInstallInfo, SkillPackageItem } from '../../../shared/types'
import { toast } from '../stores/toast'
import './skills.css'

/**
 * 技能管理页(第三方声明式技能包)。
 * 安装 = 选择含 skill.json 的目录 → 校验并展示能力清单与风险 → 确认安装;
 * tool 类技能注册为 AI 工具(默认每次人工确认),knowledge 类受控注入对话上下文。
 */

const skillApi = window.api?.cs?.skill

export default function SkillsPage(): React.JSX.Element {
  const [skills, setSkills] = useState<SkillPackageItem[] | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [installing, setInstalling] = useState(false)
  const [pending, setPending] = useState<SkillInstallInfo | null>(null)
  const [pendingDir, setPendingDir] = useState('')

  const load = async (): Promise<void> => {
    const res = await skillApi?.list().catch(() => null)
    if (res?.ok && res.skills) setSkills(res.skills as SkillPackageItem[])
    else setSkills([])
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取技能列表(全仓同款模式)
    void load()
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
      toast.success(`技能「${pending?.name}」已安装(新对话即时生效)`)
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
        第三方声明式技能包:tool 类 = HTTP 白名单执行器(每次调用需人工确认);knowledge 类 =
        受控知识注入对话上下文。仅接受 manifest,不含可执行代码,请只安装可信来源。
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

      <div className="skills-layout">
        <div className="skills-list">
          {skills === null && <div className="skills-empty">加载中…</div>}
          {skills !== null && skills.length === 0 && (
            <div className="skills-empty">
              暂无技能。选择包含 skill.json 的目录进行安装(可来自第三方分发,下载解压后选择)。
            </div>
          )}
          {skills?.map((s) => (
            <div
              key={s.id}
              className={`skill-item${selected === s.id ? ' is-active' : ''}`}
              onClick={() => setSelected(s.id)}
            >
              <div className="skill-item-main">
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
                <span className="skill-desc">{s.description}</span>
              </div>
              <div className="skill-item-ops" onClick={(e) => e.stopPropagation()}>
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

        <div className="skills-detail">
          {active ? (
            <>
              <div className="skills-detail-title">
                {active.name} <span className="skill-version">v{active.version}</span>
              </div>
              <p className="skills-detail-desc">{active.description}</p>
              <div className="skills-detail-kv">
                <span>类型</span>
                <span>
                  {active.kind === 'tool' ? '工具(HTTP 执行器,需确认)' : '知识(受控注入)'}
                </span>
                <span>作者</span>
                <span>{active.author ?? '未署名'}</span>
                <span>状态</span>
                <span>{active.enabled ? '生效(新对话可见)' : '已停用'}</span>
                <span>安装于</span>
                <span>{new Date(active.createdAt).toLocaleString()}</span>
              </div>
              <div className="skills-detail-hint">
                变更即时生效:新对话会加载该技能(工具技能出现在可用工具中;知识技能自动注入上下文)。
              </div>
            </>
          ) : (
            <div className="skills-detail-empty">
              选择左侧技能查看详情;安装新技能前会先展示能力与风险清单。
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
