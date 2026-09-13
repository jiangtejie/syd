/**
 * 飞书交互卡片（**纯函数，零依赖**）：构建 + 解析。
 *
 * 为什么单独成文件：卡片的「按钮 value」是发送端与回调端之间的唯一契约 ——
 * 两端必须严格一致，且形状错了只会在真实点按钮时才暴露，所以这里做纯函数并进离线自检。
 */

/** 卡片按钮 value 里的动作标识（回调据此认领，避免误处理别的卡片） */
export const APPROVAL_ACTION_KEY = 'tool_approval'

export interface ApprovalCardInput {
  /** 已本地化的工具名（toolCnName 的结果） */
  toolName: string
  /** 参数摘要（可选） */
  args?: string
  /** 引擎侧等待确认的 runId */
  runId: string
  /** 允许点按钮的 open_id（发起人）；空 = 不校验（历史文本确认的行为） */
  operatorOpenId?: string
}

/**
 * 工具审批卡片：确认 / 取消 两个按钮。
 * 文案口径与文本确认保持一致（「回复「确认」执行」的按钮版），并说明按钮与文本两条路都能用。
 */
export function approvalCard(input: ApprovalCardInput): Record<string, unknown> {
  const op = (input.operatorOpenId ?? '').trim()
  const value = (d: 'allow' | 'deny'): Record<string, unknown> => ({
    k: APPROVAL_ACTION_KEY,
    runId: input.runId,
    d,
    ...(op ? { op } : {})
  })
  const elements: Array<Record<string, unknown>> = [
    { tag: 'div', text: { tag: 'lark_md', content: `智能体要执行：**${input.toolName}**` } }
  ]
  const args = (input.args ?? '').trim()
  if (args) {
    elements.push({
      tag: 'div',
      text: { tag: 'lark_md', content: `参数：\`${args.slice(0, 200)}\`` }
    })
  }
  elements.push({
    tag: 'action',
    actions: [
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '确认执行' },
        type: 'primary',
        value: value('allow')
      },
      {
        tag: 'button',
        text: { tag: 'plain_text', content: '取消' },
        type: 'default',
        value: value('deny')
      }
    ]
  })
  elements.push({
    tag: 'note',
    elements: [
      { tag: 'plain_text', content: '点按钮即可；也可以直接回复「确认」/「取消」（5 分钟内有效）' }
    ]
  })
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: 'orange', title: { tag: 'plain_text', content: '⚠️ 需要你确认' } },
    elements
  }
}

/** 回调 value → 动作；不是本卡片或字段不全 → null（调用方直接忽略） */
export function parseApprovalAction(
  value: unknown
): { runId: string; allow: boolean; operatorOpenId?: string } | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (v.k !== APPROVAL_ACTION_KEY) return null
  const runId = typeof v.runId === 'string' ? v.runId.trim() : ''
  if (!runId) return null
  if (v.d !== 'allow' && v.d !== 'deny') return null
  const op = typeof v.op === 'string' ? v.op.trim() : ''
  return { runId, allow: v.d === 'allow', ...(op ? { operatorOpenId: op } : {}) }
}

/** card.action.trigger → 按钮 value（形状随 SDK 版本略有差异，这里做宽松提取） */
export function actionValueOf(payload: unknown): unknown {
  const p = payload as Record<string, unknown> | null
  const action = p?.action as Record<string, unknown> | undefined
  return action?.value
}

/** card.action.trigger → 操作者 open_id（拿不到就返回空串） */
export function operatorOpenIdOf(payload: unknown): string {
  const p = payload as Record<string, unknown> | null
  const operator = p?.operator as Record<string, unknown> | undefined
  const id = operator?.operator_id ?? operator?.open_id
  if (typeof id === 'string') return id.trim()
  if (id && typeof id === 'object') {
    const oid = (id as Record<string, unknown>).open_id
    if (typeof oid === 'string') return oid.trim()
  }
  return ''
}
