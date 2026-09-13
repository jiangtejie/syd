/**
 * 老库补列清单（数据化的 ensureColumn 调用）。
 * CREATE TABLE IF NOT EXISTS 不会给既有表加列，所以每次启动探测缺列并 ALTER ；幂等、可重复执行。
 * 只加列不改语义：改形状/搬数据请写进 `migrations.ts`（按 user_version 只跑一次）。
 */
export interface ColumnMigration {
  table: string
  column: string
  ddl: string
  /** 为什么加这一列（排查时不必回翻提交历史） */
  note: string
}

export const COLUMN_MIGRATIONS: ColumnMigration[] = [
  {
    table: 'agent_reply',
    column: 'intent_source',
    ddl: "TEXT NOT NULL DEFAULT ''",
    note: '意图来源：script（命中话术）/rule（规则层）/llm（模型复核）/none（未归类）'
  },
  {
    table: 'agent_reply',
    column: 'intent_confidence',
    ddl: 'REAL NOT NULL DEFAULT 0',
    note: '意图置信度 0~1：低于阈值时界面可提示「待确认」，也用于统计识别质量'
  },
  {
    table: 'agent_reply',
    column: 'intent_evidence',
    ddl: "TEXT NOT NULL DEFAULT ''",
    note: '意图命中词（顿号分隔）：同事质疑判定时能当场复现，而不是「模型说的」'
  },
  {
    table: 'issue_feedback',
    column: 'auto_done',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    note: '自动闭环标记：unreplied 问题检测到回复后自动关闭'
  },
  {
    table: 'issue_feedback',
    column: 'follow_up',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    note: '跟进中：客服已回复未闭环'
  },
  {
    table: 'issue_feedback',
    column: 'assignee',
    ddl: 'TEXT',
    note: '跟进人：团队客服成员 username，NULL = 未指派'
  },
  {
    table: 'issue_feedback',
    column: 'severity',
    ddl: "TEXT NOT NULL DEFAULT '一般'",
    note: '严重度：紧急/高/一般，分析提取时写入'
  },
  {
    table: 'issue_feedback',
    column: 'need_confirm',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    note: '疑似桶：规则弱命中，人工确认或归档后退出'
  },
  {
    table: 'issue_feedback',
    column: 'reopen_count',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    note: '复发计数'
  },
  {
    table: 'issue_feedback',
    column: 'reopened_from',
    ddl: 'INTEGER',
    note: '上次闭环议题 id（复发溯源）'
  },
  {
    table: 'issue_feedback',
    column: 'customers',
    ddl: 'TEXT',
    note: '涉及的客户昵称 JSON 数组，供复发/统计归一'
  },
  {
    table: 'issue_feedback',
    column: 'follow_up_at',
    ddl: 'INTEGER',
    note: '客服最后一次回复时间，跟进超时据此动态计算；NULL=规则未判定或未回复'
  },
  {
    table: 'issue_feedback',
    column: 'resolved_at',
    ddl: 'INTEGER',
    note: '闭环时间（置 done/stalled 时写入，重开清空）——趋势/今日解决口径专用'
  },
  {
    table: 'issue_feedback',
    column: 'archived_from',
    ddl: 'TEXT',
    note: '归档前状态：区分「人工判定不是问题」(open) 与「历史已解决归档」(done/stalled)'
  },
  {
    table: 'issue_feedback',
    column: 'note',
    ddl: 'TEXT',
    note: '处理备注：同事在飞书多维表格里写的结论（回写进本地供看板展示，不参与跟进判定）'
  },
  {
    table: 'issue_feedback',
    column: 'last_reply_by',
    ddl: 'TEXT',
    note: '最后回复该议题的团队客服 username；NULL = 我本人回复或无人回复'
  },
  {
    table: 'issue_feedback_msg',
    column: 'sender_username',
    ddl: 'TEXT',
    note: '证据行发送人 username（客户身份归并、复发识别）'
  },
  {
    table: 'issue_feedback_msg',
    column: 'is_team',
    ddl: 'INTEGER NOT NULL DEFAULT 0',
    note: '证据行是否团队客服（时间线我方标记）'
  },
  {
    table: 'chat_session',
    column: 'caps',
    ddl: 'TEXT',
    note: '能力分层挂载集合 JSON：{v:1,names:[...]}，会话级渐进式工具可见性'
  },
  {
    table: 'chat_session',
    column: 'workspace',
    ddl: 'TEXT',
    note: '工作区任务绑定的真实目录；NULL=未绑定，仅查询模式'
  },
  {
    table: 'chat_session',
    column: 'scope',
    ddl: "TEXT NOT NULL DEFAULT ''",
    note: '会话域：空=客服工作台，growth=营销 AI 工作台'
  },
  {
    table: 'growth_content',
    column: 'extra_json',
    ddl: "TEXT NOT NULL DEFAULT '{}'",
    note: '解析媒体源信息，如 remoteMedia'
  },
  {
    table: 'growth_metric_snapshot',
    column: 'output_id',
    ddl: 'INTEGER',
    note: '发布归因：采用的爆改产出'
  },
  {
    table: 'growth_remix_output',
    column: 'task_id',
    ddl: 'INTEGER',
    note: '候选/产出归属营销任务'
  },
  {
    table: 'lark_sync_map',
    column: 'remote_status',
    ddl: "TEXT NOT NULL DEFAULT ''",
    note: '上次同步时 Base 上的「状态」值：与当前 Base 值比对即可判断是不是同事改的'
  },
  {
    table: 'lark_sync_map',
    column: 'remote_assignee',
    ddl: "TEXT NOT NULL DEFAULT ''",
    note: '上次同步时 Base 上的「跟进人」值'
  },
  {
    table: 'lark_sync_map',
    column: 'remote_note',
    ddl: "TEXT NOT NULL DEFAULT ''",
    note: '上次同步时 Base 上的「处理备注」值'
  },
  {
    table: 'lark_sync_map',
    column: 'pushed_at',
    ddl: 'INTEGER',
    note: '最近一次推送到 Base 的时间：与本地 updated_at 比较决定冲突时谁赢（本地权威）'
  },
  {
    table: 'lark_sync_map',
    column: 'pulled_at',
    ddl: 'INTEGER',
    note: '最近一次从 Base 拉取（应用同事改动）的时间'
  },
  {
    table: 'growth_remix_output',
    column: 'meta_json',
    ddl: "TEXT NOT NULL DEFAULT '{}'",
    note: '产出元信息'
  }
]
