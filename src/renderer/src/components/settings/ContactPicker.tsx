import { useState } from 'react'
import { toast } from '../../stores/toast'

/**
 * 组织联系人选择器(设置页共用):读取通讯录可见范围 → 部门/人员列表 → 回调。
 * 用于「接收白名单」「通知接收人」等需要挑飞书同事的地方,避免各处重写一遍读取与列表逻辑。
 * 通讯录无权限(可见范围为空)时给出可行动提示与开放平台授权入口。
 */

export interface PickedContact {
  openId: string
  name: string
  email?: string
}

const api = window.api?.cs?.feishuNotify

export function ContactPicker(props: {
  /** 选中某位同事 */
  onPick: (contact: PickedContact) => void
  /** 行内按钮文案(默认「添加」) */
  pickLabel?: string
  /** 是否提供「按部门浏览」(默认关闭:只列可见范围内的人) */
  withDepartments?: boolean
}): React.JSX.Element {
  const { onPick, pickLabel = '添加', withDepartments = false } = props
  const [users, setUsers] = useState<PickedContact[]>([])
  const [departments, setDepartments] = useState<Array<{ id: string; name: string }>>([])
  const [deptPick, setDeptPick] = useState('')
  const [empty, setEmpty] = useState(false)
  const [authUrl, setAuthUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const loadScope = async (): Promise<void> => {
    setBusy(true)
    setErr('')
    try {
      const r = await api?.contactScope().catch(() => null)
      if (!r) {
        setErr('读取失败')
        return
      }
      if (!r.ok) {
        setErr(r.error || '读取通讯录可见范围失败')
        return
      }
      setDepartments(r.departments ?? [])
      setUsers(r.users ?? [])
      setEmpty(!!r.empty)
      setAuthUrl(r.authUrl ?? '')
      setDeptPick('')
      if ((r.users ?? []).length === 0) {
        setErr('通讯录可见范围为空:需在开放平台「权限管理 → 数据权限」放开可见范围')
      }
    } finally {
      setBusy(false)
    }
  }

  const loadDept = async (deptId: string): Promise<void> => {
    setDeptPick(deptId)
    if (!deptId) {
      await loadScope()
      return
    }
    setBusy(true)
    setErr('')
    try {
      const r = await api?.contactUsers(deptId).catch(() => null)
      if (!r?.ok) {
        setErr(r?.error || '读取部门成员失败')
        return
      }
      setUsers(r.users ?? [])
      if ((r.users ?? []).length === 0) setErr('该部门下没有可见成员')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div className="st-actions">
        <button type="button" className="ui-btn" disabled={busy} onClick={() => void loadScope()}>
          {busy ? '读取中…' : '读取组织联系人'}
        </button>
        {withDepartments && departments.length > 0 && (
          <select
            className="st-input"
            value={deptPick}
            onChange={(e) => void loadDept(e.target.value)}
          >
            <option value="">选择部门…</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {err && <div className="st-bad">✗ {err}</div>}
      {empty && authUrl && (
        <div className="st-actions">
          <button
            type="button"
            className="ui-btn"
            onClick={() =>
              void api?.openAuthUrl(authUrl).then((r) => {
                if (!r?.ok) toast.error(r?.error || '打开失败')
              })
            }
          >
            打开权限申请页
          </button>
        </div>
      )}
      {users.length > 0 && (
        <div className="im-list">
          {users.map((u) => (
            <div key={u.openId} className="mcp-item">
              <div className="mcp-item-main">
                <b>{u.name}</b>
                <span className="mcp-desc">{u.email || u.openId}</span>
              </div>
              <div className="mcp-item-ops">
                <button type="button" className="ui-btn is-sm" onClick={() => onPick(u)}>
                  {pickLabel}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </>
  )
}
