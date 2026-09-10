import { useEffect, useState } from 'react'
import { toast } from '../../stores/toast'

/**
 * 默认工作区(设置 → AI 助手)。
 * 飞书/IM 渠道这类没有工作台界面的会话用它作为文件工具的根目录;
 * 会话级绑定(工作台顶部「工作区」)优先于这里。
 */

const configApi = window.api?.cs?.config
const dialogApi = window.api?.cs?.dialog

export function WorkbenchWorkspaceSection(): React.JSX.Element {
  const [dir, setDir] = useState('')
  const [saved, setSaved] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    void configApi
      ?.getAll()
      .then((all) => {
        if (!alive) return
        const cur = (all['wb.defaultWorkspace'] ?? '').trim()
        setDir(cur)
        setSaved(cur)
      })
      .catch(() => undefined)
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [])

  const pick = async (): Promise<void> => {
    const r = await dialogApi?.pickDirectory('选择默认工作区目录', dir || undefined)
    if (r?.ok && r.path) setDir(r.path)
  }

  const save = async (): Promise<void> => {
    await configApi?.set('wb.defaultWorkspace', dir.trim())
    setSaved(dir.trim())
    toast.success(dir.trim() ? '默认工作区已保存' : '已清空默认工作区')
  }

  if (loading) return <div className="st-hint">加载中…</div>

  return (
    <div className="st-grid wb-skills-full">
      <div className="st-actions">
        <input
          className="st-input"
          value={dir}
          placeholder="目录绝对路径,如 D:\\work\\助理工作区"
          onChange={(e) => setDir(e.target.value)}
        />
        <button type="button" className="st-btn ghost" onClick={() => void pick()}>
          选择目录
        </button>
        <button
          type="button"
          className="st-btn"
          disabled={dir.trim() === saved}
          onClick={() => void save()}
        >
          保存
        </button>
      </div>
      <div className="st-hint">
        用于**没有工作台界面**的会话(飞书机器人 / 微信 ClawBot):AI 在这里读写文件、处理
        CSV/Excel、生成静态页面。工作台页里单个会话绑定的目录优先于此设置。
        所有读写都被限制在该目录内(防路径穿越);写/删操作按「工具审批策略」确认。
        {!saved && ' 当前未设置:飞书渠道调用文件工具时会提示去这里配置。'}
      </div>
    </div>
  )
}
