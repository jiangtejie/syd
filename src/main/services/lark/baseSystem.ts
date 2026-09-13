import { getConfig } from '../../db/repos/config'
import { larkCall } from './client'
import { fetchFields, invalidateFields, type LarkFieldMeta } from './fields'
import { createLogger } from '../logging'
import { getPersonConfig, setPersonConfig } from './personMap'

const sysLog = createLogger('lark')

/**
 * 把 Base 升级成「像系统一样」:建列 + 建视图 + 把证据关联升成双向。
 *
 * 设计原则:
 * 1. **幂等**:按名字先查再建,重复点只会显示「已存在」,不会重复造列;
 * 2. **只增不改**:不动用户已有的列,也不动数据(唯一例外是把「关联议题」从单向升成双向,
 *    这是它本来就该有的形态,失败也只是保持单向,不影响同步);
 * 3. **说清楚做不到的**:按钮列、仪表盘、自动化流程飞书没有开放创建接口,
 *    报告里直接列出「需要你手动点」的清单,不让用户以为一键就全齐了。
 *
 * 踩过的坑(实测):公式里日期相减的单位是**天**,不是毫秒 —— `NOW()-首现时间` 对 25 小时前等于 1.04;
 * 所以「小时」要 *24,「超 24h」要 >1。按毫秒写会永远算出 0 / 永远不超时。
 */

export interface UpgradeStep {
  label: string
  action: 'created' | 'skipped' | 'failed'
  detail?: string
}

export interface UpgradeReport {
  ok: boolean
  error?: string
  steps: UpgradeStep[]
  /** 飞书未开放接口、只能手动做的部分 */
  manual: string[]
}

/** 手动清单:与其假装一键搞定,不如把要点列清楚 */
export const SYSTEM_MANUAL_STEPS: string[] = [
  '按钮列(飞书未开放接口):在议题表 + 添加字段 → 类型选「按钮」;建议「认领」(更新记录:跟进人=当前用户、状态=跟进中)、「已解决」(更新记录:状态=已解决)',
  '日期格式补秒:点「首现时间 / 最近更新 / 时间」列头 → 日期格式 → 选带秒的那项(接口只到分钟)',
  '自动化(飞书未开放创建接口):① 状态=待处理且超时预警含「超」→ 发给跟进人;② 新增记录 → 发运营群卡片;③ 状态变已解决 → 回执消息',
  '仪表盘(飞书未开放创建接口):新增/解决趋势、按类型分布、按客户群 Top10 三张图',
  '视图微调:看板视图可拖动卡片排序;表单视图可设置必填项与说明后分享给同事'
]

interface ViewRow {
  view_name?: string
  view_id?: string
  view_type?: string
}

async function listViews(appToken: string, tableId: string): Promise<ViewRow[]> {
  const r = await larkCall<{ items?: ViewRow[] }>((api) =>
    api.bitable.appTableView.list({
      path: { app_token: appToken, table_id: tableId },
      params: { page_size: 100 }
    })
  )
  return r.ok ? (r.data.items ?? []) : []
}

async function ensureField(
  appToken: string,
  tableId: string,
  label: string,
  data: Record<string, unknown>,
  steps: UpgradeStep[]
): Promise<void> {
  const have = await fetchFields(appToken, tableId)
  const name = String(data.field_name ?? '')
  if (have.some((f) => f.name === name)) {
    steps.push({ label, action: 'skipped', detail: '已存在' })
    return
  }
  const r = await larkCall((api) =>
    api.bitable.appTableField.create({ path: { app_token: appToken, table_id: tableId }, data })
  )
  // 建过列 → 列缓存作废（否则紧随其后的视图/字段步骤会按旧结构判断）
  if (r.ok) invalidateFields(appToken, tableId)
  steps.push(r.ok ? { label, action: 'created' } : { label, action: 'failed', detail: r.error })
}

async function ensureView(
  appToken: string,
  tableId: string,
  label: string,
  data: Record<string, unknown>,
  steps: UpgradeStep[]
): Promise<void> {
  const have = await listViews(appToken, tableId)
  const name = String(data.view_name ?? '')
  if (have.some((v) => v.view_name === name)) {
    steps.push({ label, action: 'skipped', detail: '已存在' })
    return
  }
  const r = await larkCall((api) =>
    api.bitable.appTableView.create({ path: { app_token: appToken, table_id: tableId }, data })
  )
  steps.push(r.ok ? { label, action: 'created' } : { label, action: 'failed', detail: r.error })
}

function fieldIdOf(fields: LarkFieldMeta[], name: string): string {
  return String(fields.find((f) => f.name === name)?.fieldId ?? '')
}

/** 把议题表升级成「工单台」:编号/等待时长/超时预警/标签 + 四个视图 */
async function upgradeIssueTable(
  appToken: string,
  tableId: string,
  steps: UpgradeStep[]
): Promise<void> {
  await ensureField(
    appToken,
    tableId,
    '列:工单号(自动编号)',
    { field_name: '工单号', type: 1005 },
    steps
  )
  await ensureField(
    appToken,
    tableId,
    '列:等待时长(小时)',
    {
      field_name: '等待时长(小时)',
      type: 20,
      property: { formula_expression: 'ROUND((NOW()-首现时间)*24,1)' }
    },
    steps
  )
  await ensureField(
    appToken,
    tableId,
    '列:超时预警',
    {
      field_name: '超时预警',
      type: 20,
      property: { formula_expression: 'IF(AND(状态="待处理",NOW()-首现时间>1),"⚠ 超 24h","")' }
    },
    steps
  )
  await ensureField(
    appToken,
    tableId,
    '列:标签(多选)',
    {
      field_name: '标签',
      type: 4,
      property: { options: [{ name: '急' }, { name: '退款' }, { name: '物流' }, { name: '客诉' }] }
    },
    steps
  )
  // 人员列:只在开启映射时才建,避免给一个永远空的列
  if (getPersonConfig().enabled) {
    const personField = getPersonConfig().field
    await ensureField(
      appToken,
      tableId,
      '列:' + personField + '(人员)',
      { field_name: personField, type: 11, property: { multiple: false } },
      steps
    )
  }

  const fields = await fetchFields(appToken, tableId)
  const statusId = fieldIdOf(fields, '状态')
  const occurId = fieldIdOf(fields, '首现时间')
  if (statusId) {
    await ensureView(
      appToken,
      tableId,
      '视图:看板 · 按状态',
      {
        view_name: '看板 · 按状态',
        view_type: 'kanban',
        property: { kanban: { field_id: statusId } }
      },
      steps
    )
    await ensureView(
      appToken,
      tableId,
      '视图:待处理',
      {
        view_name: '待处理',
        view_type: 'grid',
        property: {
          filter_info: {
            conjunction: 'and',
            conditions: [{ field_id: statusId, operator: 'is', value: ['待处理'] }]
          }
        }
      },
      steps
    )
  }
  if (statusId && occurId) {
    await ensureView(
      appToken,
      tableId,
      '视图:超时未处理',
      {
        view_name: '超时未处理',
        view_type: 'grid',
        property: {
          filter_info: {
            conjunction: 'and',
            conditions: [
              { field_id: statusId, operator: 'is', value: ['待处理'] },
              { field_id: occurId, operator: 'isLess', value: ['Today'] }
            ]
          }
        }
      },
      steps
    )
  }
  await ensureView(
    appToken,
    tableId,
    '视图:新增问题(表单)',
    { view_name: '新增问题', view_type: 'form' },
    steps
  )
}

/** 证据子表:关联升成双向(议题行上出现「证据明细」) + 画册/分组视图 */
async function upgradeEvidenceTable(
  appToken: string,
  evidenceTableId: string,
  issueTableId: string,
  steps: UpgradeStep[]
): Promise<void> {
  const fields = await fetchFields(appToken, evidenceTableId)
  const link = fields.find((f) => f.name === '关联议题')
  if (!link) {
    steps.push({ label: '关联:关联议题(跳过)', action: 'skipped', detail: '没有找到该列' })
  } else if (Number(link.type) === 21) {
    steps.push({ label: '关联:关联议题已双向', action: 'skipped', detail: '已存在' })
  } else {
    const r = await larkCall((api) =>
      api.bitable.appTableField.update({
        path: {
          app_token: appToken,
          table_id: evidenceTableId,
          field_id: link.fieldId
        },
        data: {
          field_name: '关联议题',
          type: 21,
          property: { table_id: issueTableId, back_field_name: '证据明细' }
        }
      })
    )
    steps.push(
      r.ok
        ? { label: '关联:关联议题 单向 → 双向(反向列「证据明细」)', action: 'created' }
        : { label: '关联:关联议题 单向 → 双向', action: 'failed', detail: r.error }
    )
  }
  await ensureView(
    appToken,
    evidenceTableId,
    '视图:画册 · 证据图',
    { view_name: '画册 · 证据图', view_type: 'gallery' },
    steps
  )
  const issueIdCol = fieldIdOf(fields, '议题ID')
  if (issueIdCol) {
    await ensureView(
      appToken,
      evidenceTableId,
      '视图:按议题分组',
      {
        view_name: '按议题分组',
        view_type: 'grid',
        property: { group_info: [{ field_id: issueIdCol, desc: false }] }
      },
      steps
    )
  }
}

/** 影子回复表:按状态看板,手机上滑卡审话术 */
async function upgradeReplyTable(
  appToken: string,
  tableId: string,
  steps: UpgradeStep[]
): Promise<void> {
  const fields = await fetchFields(appToken, tableId)
  const statusId = fieldIdOf(fields, '状态')
  if (!statusId) {
    steps.push({ label: '视图:回复表看板(跳过)', action: 'skipped', detail: '没有状态列' })
    return
  }
  await ensureView(
    appToken,
    tableId,
    '视图:回复表看板',
    {
      view_name: '看板 · 按状态',
      view_type: 'kanban',
      property: { kanban: { field_id: statusId } }
    },
    steps
  )
}

/** 一键升级:议题表 + 证据表 + 回复表 */
export async function upgradeBaseToSystem(): Promise<UpgradeReport> {
  const appToken = (getConfig('lark.baseToken') ?? '').trim()
  if (!appToken)
    return { ok: false, error: '未配置多维表格链接', steps: [], manual: SYSTEM_MANUAL_STEPS }
  const issueTableId = (getConfig('lark.baseTableIssues') ?? '').trim()
  const evidenceTableId = (getConfig('lark.baseTableEvidence') ?? '').trim()
  const replyTableId = (getConfig('lark.baseTableReplies') ?? '').trim()
  if (!issueTableId)
    return { ok: false, error: '还未完成「验证并建表」', steps: [], manual: SYSTEM_MANUAL_STEPS }

  const steps: UpgradeStep[] = []
  try {
    await upgradeIssueTable(appToken, issueTableId, steps)
    if (evidenceTableId) await upgradeEvidenceTable(appToken, evidenceTableId, issueTableId, steps)
    if (replyTableId) await upgradeReplyTable(appToken, replyTableId, steps)
    const failed = steps.filter((s) => s.action === 'failed')
    if (failed.length > 0) sysLog.warn('表格升级有失败项: ' + failed.map((f) => f.label).join('、'))
    return { ok: failed.length === 0, steps, manual: SYSTEM_MANUAL_STEPS }
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      steps,
      manual: SYSTEM_MANUAL_STEPS
    }
  }
}

/** 设置页用:一键升级后把「人员列」也打开/关掉 */
export function setPersonColumn(enabled: boolean, field?: string): void {
  setPersonConfig({ enabled, ...(field ? { field } : {}) })
}
