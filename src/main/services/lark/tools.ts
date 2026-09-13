import type { ToolDef } from '../ai/chat/skills'
import { readBaseAsText, readDocAsText } from './api'
import { sendFeishuTextNow } from './notify'

/**
 * 飞书云文档工具(应用身份, 复用已有飞书自建应用凭证)。
 * - 读类(lark_base_tables/records/doc_read): 只读, 不需要人工审批(与软件能力同档);
 * - 写类(feishu_send_message): `confirm: true` → 走审批桥, 且只能发给设置里已配置的接收目标;
 * - 注册: cap/registry.ts(客服工作台/对话页/IM 通道按需挂载) + workbench/tools.ts(工作台常驻);
 * - 权限前提: 应用需开通多维表格/云文档只读权限, 且被加为目标文档的协作者, 详见 api.ts 错误提示。
 */

const URL_DESC =
  '飞书链接(如 https://xxx.feishu.cn/base/<token>?table=<table_id>);不传则用设置里的默认链接'

export const LARK_TOOLS: ToolDef[] = [
  {
    name: 'lark_base_tables',
    kind: 'builtin',
    needsWx: false,
    params: { url: { type: 'string', desc: URL_DESC } },
    description:
      '列出飞书多维表格(Base)里的数据表(表名 + table_id)。只读。' +
      'args: {"url":"飞书 Base 链接(可空,用设置里的默认链接)"}',
    run: async (_ctx, args) => readBaseAsText({ url: String(args?.url ?? '') })
  },
  {
    name: 'lark_base_records',
    kind: 'builtin',
    needsWx: false,
    params: {
      url: { type: 'string', desc: URL_DESC },
      table_id: { type: 'string', desc: '数据表 id(不传则先返回该 Base 的数据表清单)' },
      view_id: { type: 'string', desc: '视图 id(可空,链接里的 view=vew…)' },
      limit: { type: 'number', desc: '读取条数上限(默认 50,最大 200)' },
      page_token: { type: 'string', desc: '分页游标(上一页返回的 pageToken,可空)' }
    },
    description:
      '读取飞书多维表格指定数据表的记录(只读, 返回 Markdown 表格 + 总数与分页游标)。' +
      'args: {"url":"飞书 Base 链接","table_id":"tbl…(可空)","view_id":"vew…(可空)","limit":50,"page_token":"(可空)"}',
    run: async (_ctx, args) =>
      readBaseAsText({
        url: String(args?.url ?? ''),
        tableId: String(args?.table_id ?? '').trim() || undefined,
        viewId: String(args?.view_id ?? '').trim() || undefined,
        limit: typeof args?.limit === 'number' ? args.limit : undefined,
        pageToken: String(args?.page_token ?? '').trim() || undefined
      })
  },
  {
    name: 'feishu_send_message',
    kind: 'builtin',
    needsWx: false,
    confirm: true,
    params: {
      text: {
        type: 'string',
        required: true,
        desc: '要发送的纯文本内容（Markdown 会自动降级为纯文本）'
      },
      target: {
        type: 'string',
        desc: '接收目标名（设置里配置的群/个人显示名）；不传则发给全部目标'
      }
    },
    description:
      '把一条消息发送到飞书（机器人身份）。**写操作，需人工确认**；接收方只能是「设置 → IM 渠道 → 飞书通知」里' +
      '已配置的目标，传 target 可指定其中一个，不传则发给全部目标。发送会写审计并受日限额约束。' +
      'args: {"text":"要发送的内容","target":"目标名(可空)"}',
    run: async (_ctx, args) => {
      const res = await sendFeishuTextNow({
        text: String(args?.text ?? ''),
        targetName: String(args?.target ?? '').trim() || undefined,
        source: 'ai_tool'
      })
      if (!res.ok) return `发送失败：${res.error ?? '未知错误'}`
      return `已发送到 ${res.targets.join('、')}（成功 ${res.sent} 条${res.failed > 0 ? `，失败 ${res.failed} 条` : ''}）`
    }
  },
  {
    name: 'lark_doc_read',
    kind: 'builtin',
    needsWx: false,
    params: { url: { type: 'string', required: true, desc: '飞书云文档链接(/docx/ 或 /wiki/)' } },
    description:
      '读取飞书云文档(docx)的纯文本内容。只读。' +
      'args: {"url":"https://xxx.feishu.cn/docx/<token> 或 /wiki/<node>"}',
    run: async (_ctx, args) => readDocAsText(String(args?.url ?? ''))
  }
]

export function findLarkTool(name: string): ToolDef | undefined {
  return LARK_TOOLS.find((t) => t.name === name)
}
