import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'
import { SettingsCard, Switch } from './ui'

/**
 * 设置 → 工作台 tab:SKILL.md 业务技能管理(轻量:无市场/无安装向导)。
 * 目录:userData/skills/<name>/SKILL.md;启用(≤3 个)后按技能口径执行。
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

  const load = async (): Promise<void> => {
    const res = await wbApi?.skills().catch(() => null)
    if (res?.ok && res.skills) setSkills(res.skills as WbSkillRow[])
    else setSkills([])
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 挂载异步拉取技能列表(全仓同款模式)
    void load()
  }, [])

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

  const sizeOf = (n: number): string => (n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`)
  const MAX_ON = 3
  const list = skills ?? []
  const enabledN = list.filter((s) => s.enabled).length
  const overLimit = enabledN > MAX_ON

  return (
    <div className="st-grid wb-skills-full">
      <SettingsCard
        title="业务技能(SKILL.md)"
        desc="在技能目录放置 skills/名称/SKILL.md(frontmatter 需含 name/description),启用后 AI 会按该技能口径回答(最多同时启用 3 个,全文 ≤6k 字;无代码执行)。新会话即时生效。"
      >
        <div className="st-actions wb-skills-toolbar">
          <button type="button" className="st-btn ghost sm" onClick={() => void openDir()}>
            打开技能目录
          </button>
          {dir && <span className="st-hint wb-skills-dir">{dir}</span>}
          {skills !== null && list.length > 0 && (
            <span className={`wb-skills-count${overLimit ? ' over' : ''}`}>
              共 {list.length} 个 · 已启用 {enabledN}
              {overLimit ? `(超过 ${MAX_ON} 个上限,请先停用多余技能)` : `/${MAX_ON}`}
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
