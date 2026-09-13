import { useState } from 'react'
import { toast } from '../../stores/toast'
import { SettingsCard, Switch } from './ui'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

/**
 * 设置 → 技能 tab(tab key 仍为 workbench):SKILL.md 业务技能管理(轻量:无市场/无安装向导)。
 * 目录:userData/skills/<name>/SKILL.md;按「同时启用上限」(默认 3,可调 1~6)执行。
 */

interface WbSkillRow {
  name: string
  description: string
  enabled: boolean
  sizeBytes: number
  dirName: string
}

const wbApi = window.api?.cs?.wb

export default function WorkbenchSkillsSection(): React.JSX.Element {
  const [skills, setSkills] = useState<WbSkillRow[] | null>(null)
  const [dir, setDir] = useState('')
  const [limit, setLimit] = useState(3)
  const [limitSaving, setLimitSaving] = useState(false)

  const load = async (): Promise<void> => {
    const res = await wbApi?.skills().catch(() => null)
    if (res?.ok) {
      if (res.skills) setSkills(res.skills as WbSkillRow[])
      else setSkills([])
      if (typeof res.maxOn === 'number') setLimit(res.maxOn)
    } else setSkills([])
  }

  useAsyncEffect(load, [])

  const openDir = async (): Promise<void> => {
    const res = await wbApi?.openSkillsDir().catch(() => null)
    if (res?.ok) setDir(res.path ?? '')
    if (res && !res.ok) toast.error(res.error ?? '打开失败')
  }

  const toggle = async (s: WbSkillRow): Promise<void> => {
    const res = await wbApi?.toggleSkill(s.name, !s.enabled).catch(() => null)
    if (res?.ok) {
      setSkills((prev) =>
        (prev ?? []).map((x) => (x.name === s.name ? { ...x, enabled: !s.enabled } : x))
      )
    } else {
      toast.error((res as { error?: string } | null)?.error ?? '操作失败')
    }
  }

  /** 调整同时启用上限(1~6),成功以主进程返回值为准 */
  const changeLimit = async (n: number): Promise<void> => {
    const prev = limit
    setLimit(n)
    setLimitSaving(true)
    try {
      const res = await wbApi?.setSkillLimit(n).catch(() => null)
      if (res?.ok && typeof res.maxOn === 'number') {
        setLimit(res.maxOn)
        toast.success(`技能上限已调整为同时启用 ${res.maxOn} 个`)
      } else {
        setLimit(prev)
        toast.error((res as { error?: string } | null)?.error ?? '设置失败')
      }
    } finally {
      setLimitSaving(false)
    }
  }

  const sizeOf = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
  const list = skills ?? []
  const enabledN = list.filter((s) => s.enabled).length
  const overLimit = enabledN > limit

  return (
    <div className="st-grid wb-skills-full">
      <SettingsCard
        title="业务技能(SKILL.md)"
        desc="在技能目录放置 skills/名称/SKILL.md(frontmatter 需含 name/description),启用后 AI 会按该技能口径回答;同时启用上限默认 3 个,可在右上角调至 1~6(注入预算随上限放大,无代码执行)。新会话即时生效。"
      >
        <div className="st-actions wb-skills-toolbar">
          <button type="button" className="ui-btn is-sm" onClick={() => void openDir()}>
            打开技能目录
          </button>
          {dir && <span className="st-hint wb-skills-dir">{dir}</span>}
          {skills !== null && (
            <span
              className="wb-limit-pick"
              title="同时最多启用几个技能(影响每次 AI 请求注入的技能全文量)"
            >
              <span className="wb-limit-tag">上限</span>
              <select
                className="st-input wb-limit-sel"
                value={limit}
                disabled={limitSaving}
                onChange={(e) => void changeLimit(Number(e.target.value))}
              >
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </span>
          )}
          {skills !== null && list.length > 0 && (
            <span className={`wb-skills-count${overLimit ? ' over' : ''}`}>
              共 {list.length} 个 · 已启用 {enabledN}
              {overLimit ? `(超过 ${limit} 个上限,请先停用多余技能)` : `/${limit}`}
            </span>
          )}
        </div>
        {skills === null && <div className="st-hint">加载中…</div>}
        {skills !== null && list.length === 0 && (
          <div className="st-hint">
            暂无技能。把含 SKILL.md
            的目录放进技能目录后,点“打开技能目录”查看并重启该设置页即可识别。
          </div>
        )}
        {skills !== null && list.length > 0 && (
          <div className="wb-skill-grid">
            {list.map((s) => (
              <div key={s.name} className={`wb-skill-card${s.enabled ? ' is-on' : ''}`}>
                <div className="wb-skill-head">
                  <b className="wb-skill-name" title={s.name}>
                    {s.name}
                  </b>
                  <Switch
                    checked={s.enabled}
                    onChange={() => void toggle(s)}
                    label={`启用技能 ${s.name}`}
                  />
                </div>
                {s.description && <p className="wb-skill-desc">{s.description}</p>}
                <div className="wb-skill-meta">
                  <span className={`wb-skill-state${s.enabled ? ' on' : ''}`}>
                    {s.enabled ? '已启用' : '停用'}
                  </span>
                  <span>{sizeOf(s.sizeBytes)}</span>
                  <span className="wb-skill-dir" title={s.dirName}>
                    {s.dirName}
                  </span>
                </div>
              </div>
            ))}
          </div>
        )}
      </SettingsCard>
    </div>
  )
}
