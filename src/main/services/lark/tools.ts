import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolDef } from '../ai/chat/skills'
import { readBaseAsText, readDocAsText, writeBaseRecordAsText } from './api'
import { larkDownloadMedia } from './client'
import { sendFeishuTextNow } from './notify'
import { getFilesRootDir } from '../paths'
import { safeFileName } from '../_filename'
import { atTag, withMentions } from '../im/mention'
import { openIdOf } from './personMap'

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
      page_token: { type: 'string', desc: '分页游标(上一页返回的 pageToken,可空)' },
      filter: { type: 'string', desc: '筛选公式(飞书语法),如 CurrentValue.[状态]="待处理"' },
      sort: { type: 'string', desc: '排序 JSON,如 [{"field_name":"最近更新","desc":true}]' }
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
        pageToken: String(args?.page_token ?? '').trim() || undefined,
        filter: String(args?.filter ?? '').trim() || undefined,
        sort: String(args?.sort ?? '').trim() || undefined
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
      },
      mention: {
        type: 'string',
        desc: '要 @ 的人：open_id（ou_…）或团队里的称呼（跟进人里的名字）'
      }
    },
    description:
      '把一条消息发送到飞书（机器人身份）。**写操作，需人工确认**；接收方只能是「设置 → IM 渠道 → 飞书通知」里' +
      '已配置的目标，传 target 可指定其中一个，不传则发给全部目标。传 mention 可在正文前 @ 某人（群消息才会真正通知到人）。' +
      '发送会写审计并受日限额约束。args: {"text":"要发送的内容","target":"目标名(可空)","mention":"ou_… 或 称呼(可空)"}',
    run: async (_ctx, args) => {
      const text = String(args?.text ?? '')
      const mention = String(args?.mention ?? '').trim()
      const openId = mention ? (/^ou_/.test(mention) ? mention : openIdOf(mention)) : ''
      const tag = atTag(openId, mention)
      const res = await sendFeishuTextNow({
        text: withMentions(text, tag ? [tag] : []),
        targetName: String(args?.target ?? '').trim() || undefined,
        source: 'ai_tool'
      })
      if (!res.ok) return `发送失败：${res.error ?? '未知错误'}`
      if (mention && !tag) {
        return `已发送到 ${res.targets.join('、')}；但「${mention}」没查到 open_id，本条没有 @ 到人（可在设置 → IM 渠道 → 飞书通知 → 加同事里维护人员映射）`
      }
      return `已发送到 ${res.targets.join('、')}（成功 ${res.sent} 条${res.failed > 0 ? `，失败 ${res.failed} 条` : ''}）`
    }
  },
  {
    name: 'feishu_base_write',
    kind: 'builtin',
    needsWx: false,
    confirm: true,
    params: {
      url: { type: 'string', desc: URL_DESC },
      table_id: { type: 'string', desc: '数据表 id(可空,链接里带 ?table= 时可不填)' },
      record_id: { type: 'string', desc: '要更新的记录 id(rec…);不传 = 新增一条' },
      fields: { type: 'string', required: true, desc: 'JSON 对象:列名 → 值(列名用表里的原名)' }
    },
    description:
      '写入飞书多维表格一行(新增或更新)。写操作,需人工确认;不传 record_id 为新增,传了为更新。' +
      'args: {"url":"飞书 Base 链接","table_id":"tbl…(可空)","record_id":"rec…(可空)","fields":"{状态:跟进中}"}',
    run: async (_ctx, args) =>
      writeBaseRecordAsText({
        url: String(args?.url ?? ''),
        tableId: String(args?.table_id ?? '').trim() || undefined,
        recordId: String(args?.record_id ?? '').trim() || undefined,
        fieldsJson: String(args?.fields ?? '')
      })
  },
  {
    name: 'feishu_file_download',
    kind: 'builtin',
    needsWx: false,
    params: {
      file_token: {
        type: 'string',
        required: true,
        desc: '素材 file_token(多维表格附件列里的 file_token)'
      },
      name: { type: 'string', desc: '保存文件名(含扩展名;不传用 token 兜底)' }
    },
    description:
      '把飞书素材(附件列里的文件/图片)下载到本机 lark-files 目录。只读,不改飞书数据。' +
      'args: {"file_token":"boxcn…","name":"对账单.xlsx"}',
    run: async (_ctx, args) => {
      const token = String(args?.file_token ?? '').trim()
      if (!token) return '缺少 file_token。'
      const r = await larkDownloadMedia(token)
      if (!r.ok) return `下载失败：${r.error}`
      const raw = String(args?.name ?? '').trim() || token + '.bin'
      const dir = join(getFilesRootDir(), 'lark-files')
      await mkdir(dir, { recursive: true })
      const file = join(dir, safeFileName(raw, { fallback: token + '.bin' }))
      await writeFile(file, r.buf)
      return `已下载 ${file}（${r.buf.length} 字节）`
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
