import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'
import { SettingsCard, SwitchRow } from './ui'

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

  return (
    <div className="st-grid">
      <SettingsCard
        title="业务技能(SKILL.md)"
        desc="在技能目录放置 skills/名称/SKILL.md(frontmatter 需含 name/description),启用后 AI 会按该技能口径回答(最多同时启用 3 个,全文 ≤6k 字;无代码执行)。新会话即时生效。"
      >
        <div className="st-actions">
          <button type="button" className="st-btn ghost sm" onClick={() => void openDir()}>
            打开技能目录
          </button>
          {dir && <span className="st-hint">{dir}</span>}
        </div>
        {skills === null && <div className="st-hint">加载中…</div>}
        {skills !== null && skills.length === 0 && (
          <div className="st-hint">
            暂无技能。把含 SKILL.md
            的目录放进技能目录后,点“打开技能目录”查看并重启该设置页即可识别。
          </div>
        )}
        {skills?.map((s) => (
          <SwitchRow
            key={s.name}
            label={s.name}
            desc={`${s.description} · ${sizeOf(s.sizeBytes)} · 目录 ${s.dirName}`}
            checked={s.enabled}
            onChange={() => void toggle(s)}
          />
        ))}
      </SettingsCard>
    </div>
  )
}
