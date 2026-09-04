/** 工作台引擎公共类型(主进程/渲染共享语义;渲染侧事件结构与此对齐)。 */

/** 工具卡展示状态 */
export type WbToolStatus = 'start' | 'pending' | 'done' | 'fail'

/** ai:wb 事件(增量/推理/工具/审批/压缩标记/完成/错误/状态) */
export interface WbEvent {
  sessionId: number
  type: 'delta' | 'reasoning' | 'tool' | 'approval' | 'compaction' | 'done' | 'error' | 'status'
  token?: string
  tool?: string
  toolStatus?: WbToolStatus
  /** 工具调用参数(JSON 摘要,≤4000 字符) */
  args?: string
  /** 工具结果(截断至 ≤4000 字符,outTrunc=true 表示有截断) */
  output?: string
  outTrunc?: boolean
  /** 工具结果截断(旧字段,保留兼容) */
  resultClip?: string
  /** 审批 runId(approval 事件携带) */
  runId?: string
  /** 审批请求摘要 */
  approvalText?: string
  messageId?: number
  text?: string
}

/** 审批请求内容(引擎 → 渲染) */
export interface WbApprovalRequest {
  runId: string
  tool: string
  args: string
  /** 人类可读的一行说明 */
  summary: string
  timeoutMs: number
}

/** SKILL.md 技能信息 */
export interface WbSkillInfo {
  name: string
  description: string
  enabled: boolean
  sizeBytes: number
  /** 目录相对名(与 SKILL.md 所在目录同名) */
  dirName: string
}

/** 会话工具集分组(id → 说明与工具名) */
export interface WbToolGroup {
  id: string
  /** 固定菜单里的一行说明(跨轮不变,prompt-cache 友好) */
  label: string
  tools: string[]
}
