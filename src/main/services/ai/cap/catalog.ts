/**
 * 能力目录的**静态元数据**（零依赖纯数据）。
 *
 * 为什么单独成文件：注册表（registry.ts）要读配置、要调各模块的 findXxxTool，因而会连带引入 DB/SDK 链路，
 * 纯 Node 里跑不起来；而「目录行 / 触发场景 / 属于哪一组」全是纯数据 —— 放这里之后，能力目录的契约
 * （命名唯一、目录行齐全、分组合法）就能被 scripts/tool-registry-selftest.mjs 离线覆盖。
 * 注册表只负责把元数据与「可执行 def」拼起来。
 */

export type CapGroup = 'core' | 'wechat' | 'software' | 'cloud' | 'workspace'

/** 分组展示名（目录、工作台菜单共用） */
export const GROUP_TEXT: Record<CapGroup, string> = {
  core: '核心',
  wechat: '微信业务',
  software: '软件能力',
  cloud: '飞书云文档',
  workspace: '工作区文件'
}

/** 能力元数据（与可执行 def 通过 name 对应） */
export interface CapCatalogEntry {
  name: string
  oneLine: string
  when: string
  /** 依赖微信账号上下文 */
  needsWx?: boolean
}

/** 内置微信业务能力：目录行靠名字映射（实现分散在 skills.ts / software.ts / lark/tools.ts / wsTools.ts） */
export const WHEN_HINT: Record<string, { oneLine: string; when: string }> = {
  query_issues: {
    oneLine: '查本账号记录的问题/客诉(按关键词/状态/严重度)',
    when: '用户问“有没有 XX 问题、待处理客诉、某类投诉记录”时'
  },
  query_group_issues: {
    oneLine: '查指定群(或当前聊天对象)的问题列表,待处理优先',
    when: '用户问某个群近期有哪些问题时'
  },
  search_issue_history: {
    oneLine: '跨群搜索历史客户问题,判断是否重复诉求',
    when: '用户问“这客户之前提过吗/上次怎么处理的”时'
  },
  list_team_members: {
    oneLine: '列出已标记的团队客服成员(自己人)',
    when: '需要区分我方同事发言与客户诉求时'
  },
  monitor_summary: {
    oneLine: '问题监控概览:待办/跟进/紧急/今日新增/疑似',
    when: '用户问监控、待办、紧急情况、KPI 口径数据时'
  },
  customer_lookup: {
    oneLine: '查客户/群资料:显示名/备注/未读/最后消息',
    when: '用户问某个客户或群的基本情况时'
  },
  recent_messages: {
    oneLine: '读指定会话最近消息文本',
    when: '需要知道一个会话刚聊了什么时'
  },
  send_message: {
    oneLine: '发送文本消息给指定客户/群(写操作,执行前需人工确认)',
    when: '用户明确要求给某个客户/群发送微信消息时'
  },
  resolve_issue: {
    oneLine: '把问题标记为已解决(写操作,按审批策略确认)',
    when: '用户说“这个问题处理完了 / 已解决 / 结掉”时'
  },
  stall_issue: {
    oneLine: '把问题标记为已搁置(写操作,按审批策略确认)',
    when: '用户说“这个问题先搁置 / 暂不处理”时'
  },
  assign_issue: {
    oneLine: '指派/取消问题的跟进人(写操作,按审批策略确认)',
    when: '用户要求把问题分给某位同事跟进时'
  }
}

export const SOFTWARE_CAPS: Array<{
  name: string
  needsWx: boolean
  oneLine: string
  when: string
}> = [
  {
    name: 'software_status',
    needsWx: false,
    oneLine: '软件与账号状态:版本/绑定账号/通道/模型/监控开关',
    when: '用户问“这软件能用吗/连了哪些账号/什么模型/状态如何”时'
  },
  {
    name: 'data_scope',
    needsWx: true,
    oneLine: '数据覆盖范围:会话构成/时间跨度/记录量级(只读)',
    when: '用户问“能看到多少数据、数据全不全、最早到什么时候”时'
  },
  {
    name: 'bi_stats',
    needsWx: true,
    oneLine: '业务统计:问题/会话/消息量与 7 日趋势(只读)',
    when: '用户问“最近业务量、趋势、排行、日报口径”时'
  },
  {
    name: 'im_channels_status',
    needsWx: false,
    oneLine: 'IM 渠道(飞书机器人等)账号连接状态',
    when: '用户问“机器人接了吗、飞书状态如何”时'
  },
  {
    name: 'memory_view',
    needsWx: false,
    oneLine: '查看当前可用的长期上下文来源(只读)',
    when: '用户问“你记得什么、有哪些上下文可用”时'
  },
  {
    name: 'export_preview',
    needsWx: true,
    oneLine: '导出数据范围估算(会话/消息/目标数,不执行导出)',
    when: '用户问“能导出什么、导多少”时'
  }
]

export const LARK_CAPS: Array<{
  name: string
  oneLine: string
  when: string
}> = [
  {
    name: 'lark_base_tables',
    oneLine: '列出飞书多维表格(Base)里的数据表(表名 + table_id)',
    when: '用户给了 /base/ 链接、或问“这张飞书表格里有哪些表”时'
  },
  {
    name: 'lark_base_records',
    oneLine: '读取飞书多维表格指定数据表的记录(只读,分页,Markdown 表格返回)',
    when: '需要读飞书多维表格里的行数据(名单/台账/排期表)时'
  },
  {
    name: 'lark_doc_read',
    oneLine: '读取飞书云文档(docx/知识库)的纯文本内容',
    when: '用户给了飞书文档链接、要你总结或提取其中内容时'
  },
  {
    name: 'feishu_base_write',
    oneLine: '写入飞书多维表格一行(新增/更新,写操作按审批策略确认)',
    when: '用户要求把结论/进展写回飞书表格、或让你登记一条记录时'
  },
  {
    name: 'feishu_file_download',
    oneLine: '把飞书附件列里的文件/图片下载到本机 lark-files',
    when: '需要把飞书表格里的附件取到本地查看/处理时'
  },
  {
    name: 'feishu_send_message',
    oneLine: '把消息发到飞书(写操作,按审批策略确认;接收方为设置里已配置的目标)',
    when: '用户要求“把这条发到飞书 / 通知群里 / 发给我”时'
  }
]

export const WS_CAPS: Array<{
  name: string
  oneLine: string
  when: string
}> = [
  {
    name: 'workspace_list',
    oneLine: '列出工作区目录与文件(相对路径,可递归)',
    when: '想先看工作区里有哪些文件时'
  },
  {
    name: 'workspace_read',
    oneLine: '读取工作区内的文本文件(≤300KB)',
    when: '需要某个文件的内容时'
  },
  {
    name: 'workspace_search',
    oneLine: '在工作区内按关键词搜索文件内容',
    when: '问“哪份文件提到过 XX”时'
  },
  {
    name: 'workspace_file_info',
    oneLine: '查看文件/目录的大小与修改时间',
    when: '确认文件是否存在、多大、何时改过时'
  },
  {
    name: 'workspace_write',
    oneLine: '写入/覆盖工作区文本文件(写操作,按审批策略确认)',
    when: '需要新建或修改文件时'
  },
  {
    name: 'workspace_mkdir',
    oneLine: '在工作区新建目录(写操作,按审批策略确认)',
    when: '需要建目录归类时'
  },
  {
    name: 'workspace_delete',
    oneLine: '删除工作区文件/空目录(写操作,按审批策略确认)',
    when: '需要清理文件时'
  },
  {
    name: 'csv_read',
    oneLine: '读取 CSV 的表头与数据行',
    when: '处理名单/台账等 CSV 时'
  },
  {
    name: 'csv_append',
    oneLine: '向 CSV 追加数据行(写操作,按审批策略确认)',
    when: '往名单/台账追加记录时'
  },
  {
    name: 'xlsx_preview',
    oneLine: '预览 Excel 工作表结构与前若干行',
    when: '处理 Excel 表格时'
  },
  {
    name: 'xlsx_write',
    oneLine: '写出 Excel(二维数组)(写操作,按审批策略确认)',
    when: '需要生成 Excel 报表时'
  },
  {
    name: 'site_scaffold',
    oneLine: '生成静态站点骨架(写操作,按审批策略确认)',
    when: '要做落地页/帮助页等静态页面时'
  }
]
