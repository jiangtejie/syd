import { getLarkCredential, larkCall, type LarkCallResult } from './client'

/**
 * 飞书组织联系人(通讯录)。
 *
 * 重要:能否读到人,由两件事共同决定——
 *   ① API 权限(contact:user.base:readonly / contact:user.id:readonly / contact:department.base:readonly);
 *   ② **数据权限可见范围**(开放平台「权限管理 → 数据权限」:全部员工 / 指定部门 / 仅自己)。
 * 只开 ① 不开 ② 时,接口会返回 403 code 40004(no dept authority)或只返回极少数人。
 * 因此本模块先查「应用当前可见范围」(/contact/v3/scopes),再按需列部门/人员,并把授权链接带回去。
 */

export interface ContactUser {
  openId: string
  name: string
  email?: string
  departmentIds?: string[]
}

export interface ContactDepartment {
  id: string
  name: string
}

/** 通讯录可见范围(应用身份能看到的部门与人员) */
export interface ContactScopeInfo {
  departments: ContactDepartment[]
  users: ContactUser[]
  /** 可见范围是否为空(需要去开放平台配数据权限) */
  empty: boolean
  /** 一键授权链接(缺 scope 时给用户点) */
  authUrl: string
  appIdMasked: string
}

function authUrl(): string {
  const cred = getLarkCredential()
  const scopes = 'contact:user.id:readonly,contact:department.base:readonly'
  if (!cred.appId) return 'https://open.feishu.cn/app'
  return `https://open.feishu.cn/app/${cred.appId}/auth?q=${scopes}&op_from=openapi&token_type=tenant`
}

/** 单个用户信息(open_id → 姓名/邮箱/部门) */
export async function getContactUser(openId: string): Promise<LarkCallResult<ContactUser>> {
  const id = (openId ?? '').trim()
  if (!id) return { ok: false, error: '缺少 open_id' }
  const r = await larkCall<{
    user?: { open_id?: string; name?: string; email?: string; department_ids?: string[] }
  }>((api) =>
    api.request({
      method: 'GET',
      url: `open-apis/contact/v3/users/${id}`,
      params: { user_id_type: 'open_id' }
    })
  )
  if (!r.ok) return r
  const u = r.data.user
  if (!u?.open_id) return { ok: false, error: '未返回用户信息' }
  return {
    ok: true,
    data: {
      openId: u.open_id,
      name: u.name || u.open_id.slice(0, 10),
      email: u.email,
      departmentIds: u.department_ids
    }
  }
}

/** 应用当前可见范围(部门 + 人员,人员会尽量补上姓名) */
export async function getContactScope(): Promise<LarkCallResult<ContactScopeInfo>> {
  const cred = getLarkCredential()
  const r = await larkCall<{ user_ids?: string[]; department_ids?: string[] }>((api) =>
    api.request({ method: 'GET', url: 'open-apis/contact/v3/scopes' })
  )
  if (!r.ok) return r
  const userIds = (r.data.user_ids ?? []).filter(Boolean)
  const deptIds = (r.data.department_ids ?? []).filter(Boolean)
  const users: ContactUser[] = []
  for (const id of userIds.slice(0, 30)) {
    const u = await getContactUser(id)
    if (u.ok) users.push(u.data)
    else users.push({ openId: id, name: id.slice(0, 10) })
  }
  return {
    ok: true,
    data: {
      departments: deptIds.map((id) => ({ id, name: id })),
      users,
      empty: userIds.length === 0 && deptIds.length === 0,
      authUrl: authUrl(),
      appIdMasked: cred.appId ? `${cred.appId.slice(0, 8)}…${cred.appId.slice(-4)}` : ''
    }
  }
}

/** 部门下的子部门(parentId 传 '0' 表示根部门) */
export async function listDepartments(
  parentId = '0'
): Promise<
  LarkCallResult<{ departments: ContactDepartment[]; hasMore: boolean; pageToken?: string }>
> {
  const r = await larkCall<{
    items?: Array<{ name?: string; open_department_id?: string; department_id?: string }>
    has_more?: boolean
    page_token?: string
  }>((api) =>
    api.request({
      method: 'GET',
      url: `open-apis/contact/v3/departments/${parentId}/children`,
      params: {
        page_size: 50,
        department_id_type: 'open_department_id',
        fetch_child: false,
        user_id_type: 'open_id'
      }
    })
  )
  if (!r.ok) return r
  const departments = (r.data.items ?? [])
    .map((d) => ({
      id: d.open_department_id ?? d.department_id ?? '',
      name: d.name || '(未命名部门)'
    }))
    .filter((d) => !!d.id)
  return {
    ok: true,
    data: { departments, hasMore: !!r.data.has_more, pageToken: r.data.page_token }
  }
}

/** 部门直属成员(deptId 传 '0' 表示根部门直属) */
export async function listDepartmentUsers(
  deptId = '0',
  opts: { pageSize?: number; pageToken?: string } = {}
): Promise<LarkCallResult<{ users: ContactUser[]; hasMore: boolean; pageToken?: string }>> {
  const r = await larkCall<{
    items?: Array<{
      open_id?: string
      name?: string
      email?: string
      department_ids?: string[]
    }>
    has_more?: boolean
    page_token?: string
  }>((api) =>
    api.request({
      method: 'GET',
      url: 'open-apis/contact/v3/users/find_by_department',
      params: {
        department_id: deptId,
        department_id_type: 'open_department_id',
        user_id_type: 'open_id',
        page_size: Math.min(Math.max(opts.pageSize ?? 50, 1), 50),
        ...(opts.pageToken ? { page_token: opts.pageToken } : {})
      }
    })
  )
  if (!r.ok) return r
  const users = (r.data.items ?? [])
    .filter((u) => !!u.open_id)
    .map((u) => ({
      openId: u.open_id as string,
      name: u.name || (u.open_id as string).slice(0, 10),
      email: u.email,
      departmentIds: u.department_ids
    }))
  return { ok: true, data: { users, hasMore: !!r.data.has_more, pageToken: r.data.page_token } }
}
