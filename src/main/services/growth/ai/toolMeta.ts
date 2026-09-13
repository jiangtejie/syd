import type { ToolParamDecl } from '../../ai/chat/skills'

/**
 * 营销域工具元数据（**零依赖纯数据**）。
 *
 * 为什么单独成文件：
 * 1. 能力注册表（cap/registry.ts）需要「目录行 + 触发场景 + 是否写操作 + 参数声明」，
 *    而这些是纯数据 —— 放在这里后，注册表契约可以被离线自检覆盖（scripts/tool-registry-selftest.mjs）；
 * 2. 实现层（growthToolDefs.ts）与元数据分开，参数声明只写一份，避免「注册表说有 A 参数、实现里是 B」。
 *
 * 参数命名沿用营销页既有 camelCase（storeId/outputId/…），新增的上下文覆盖参数为 contentId/taskId。
 */

export interface GrowthToolMeta {
  name: string
  /** 目录行：一句话用途 */
  oneLine: string
  /** 何时使用（给模型） */
  when: string
  /** 写操作（改数据/花钱/落盘）→ 走审批桥 */
  confirm: boolean
  /** 需要「当前营销任务」上下文；缺失时必须由调用方显式传 contentId */
  needsContent?: boolean
  /** 需要任务 id（生成图/改写会挂到任务上） */
  needsTask?: boolean
  /** 需要门店档案上下文 */
  needsStore?: boolean
  params: Record<string, ToolParamDecl>
}

const STYLE_ENUM = ['tanDian', 'shangXin', 'cuXiao', 'renShe', 'auto']
const STORE_FACT_KEYS = [
  'city',
  'address',
  'phone',
  'hours',
  'avgPrice',
  'signatureDishes',
  'packages',
  'parking',
  'privateRoom',
  'note'
]

export const GROWTH_TOOL_META: GrowthToolMeta[] = [
  {
    name: 'growth_read_material',
    oneLine: '读取营销任务素材(标题/正文/互动/本地图片/拆解卡)',
    when: '要爆改或分析某条素材前，先读它看原始内容时',
    confirm: false,
    needsContent: true,
    params: { contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' } }
  },
  {
    name: 'growth_get_store',
    oneLine: '读门店/品牌档案(地址/电话/营业时间/招牌菜/套餐/语气)',
    when: '要写门店相关文案、需要真实事实而不是编造时',
    confirm: false,
    needsStore: true,
    params: { storeId: { type: 'number', desc: '门店 id（不传用当前任务门店/默认门店）' } }
  },
  {
    name: 'growth_search_web',
    oneLine: '联网搜索公开信息(门店信息/菜品做法/口碑)，结果仅供参考',
    when: '需要查门店地址/电话/做法/口碑等公开信息时',
    confirm: false,
    params: {
      query: { type: 'string', required: true, desc: '搜索关键词' },
      count: { type: 'number', desc: '结果条数（默认 5）' }
    }
  },
  {
    name: 'growth_search_images',
    oneLine: '联网检索参考图(菜品/环境)，仅作参考不可直接对外发布',
    when: '需要找配图灵感或参考图时',
    confirm: false,
    params: {
      query: { type: 'string', required: true, desc: '图片检索关键词' },
      count: { type: 'number', desc: '结果条数（默认 5）' }
    }
  },
  {
    name: 'growth_read_lark_base',
    oneLine: '读飞书多维表格(选品表/排期表/门店清单/素材台账)',
    when: '运营的表在飞书里、需要按表里的口径写文案或核对信息时',
    confirm: false,
    params: {
      url: { type: 'string', desc: '飞书 Base 链接（不传用设置里的默认链接）' },
      table_id: { type: 'string', desc: '数据表 id（不传先返回表清单）' },
      view_id: { type: 'string', desc: '视图 id（可空）' },
      limit: { type: 'number', desc: '读取条数上限（默认 30，最大 200）' }
    }
  },
  {
    name: 'growth_gen_image',
    oneLine: 'AI 生成候选图(封面/氛围图/菜品示意)，需标注「AI 生成示意图」',
    when: '需要配图但门店没有可用素材时',
    confirm: true,
    needsContent: true,
    needsTask: true,
    params: {
      prompt: { type: 'string', required: true, desc: '画面描述（风格/光线/场景/主体）' },
      count: { type: 'number', desc: '生成张数（默认 2）' },
      role: { type: 'enum', enum: ['cover', 'image'], desc: '用途：封面 / 正文图' },
      contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' },
      taskId: { type: 'number', desc: '任务 id（不传用当前任务）' }
    }
  },
  {
    name: 'growth_rewrite_title',
    oneLine: '生成标题候选(3~5 条)，用户点选后才写入产出',
    when: '需要改写标题、要几个不同方向的候选时',
    confirm: true,
    needsContent: true,
    needsTask: true,
    needsStore: true,
    params: {
      strategy: { type: 'string', desc: '策略/要求，如「突出人均80」' },
      style: { type: 'enum', enum: STYLE_ENUM, desc: '风格（默认 auto 沿用素材风格）' },
      contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' },
      taskId: { type: 'number', desc: '任务 id（不传用当前任务）' },
      storeId: { type: 'number', desc: '门店 id（不传用当前任务门店）' }
    }
  },
  {
    name: 'growth_rewrite_copy',
    oneLine: '生成/改写正文候选(1~3 篇)，用户点选后才写入产出',
    when: '需要重写正文、或按指令调整某几段时',
    confirm: true,
    needsContent: true,
    needsTask: true,
    needsStore: true,
    params: {
      instruction: { type: 'string', desc: '改写要求，如「精简第二段」' },
      style: { type: 'enum', enum: STYLE_ENUM, desc: '风格（默认 auto）' },
      copies: { type: 'number', desc: '生成篇数（默认 2）' },
      contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' },
      taskId: { type: 'number', desc: '任务 id（不传用当前任务）' },
      storeId: { type: 'number', desc: '门店 id（不传用当前任务门店）' }
    }
  },
  {
    name: 'growth_update_output',
    oneLine: '把选定的候选写入产出，或直接改产出文本/状态',
    when: '用户点选某条候选、或要求修改/归档产出时',
    confirm: true,
    params: {
      outputId: { type: 'number', required: true, desc: '产出块 id' },
      title: { type: 'string', desc: '新标题（可空）' },
      copy: { type: 'string', desc: '新正文（可空）' },
      status: { type: 'enum', enum: ['selected', 'archived'], desc: '状态：已采用 / 归档' }
    }
  },
  {
    name: 'growth_replace_image',
    oneLine: '替换产出图集(门店素材/生成候选图/联网图，联网图需确认版权)',
    when: '用户要求换封面或换某张配图时',
    confirm: true,
    needsContent: true,
    params: {
      outputId: { type: 'number', required: true, desc: '产出块 id' },
      assetId: { type: 'number', desc: '素材库图片 id' },
      remoteUrl: { type: 'string', desc: '联网图片地址（需确认版权）' },
      role: { type: 'enum', enum: ['cover', 'image'], desc: '位置：封面 / 正文图' },
      contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' }
    }
  },
  {
    name: 'growth_save_store_fact',
    oneLine: '把已确认的门店事实写入门店档案（联网查到的事实必须先确认）',
    when: '用户确认了一条门店事实（地址/电话/营业时间等）后',
    confirm: true,
    needsStore: true,
    params: {
      storeId: { type: 'number', desc: '门店 id（不传用当前门店）' },
      key: { type: 'enum', enum: STORE_FACT_KEYS, required: true, desc: '事实字段' },
      value: { type: 'string', required: true, desc: '字段值' }
    }
  },
  {
    name: 'growth_export_package',
    oneLine: '导出发布包(文案 + 图集 + 视频链接)到目录',
    when: '用户要交付/备份某条内容的发布物料时',
    confirm: true,
    needsContent: true,
    params: {
      outputIds: { type: 'number_array', desc: '要导出的产出 id 列表（不传=全部）' },
      contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' }
    }
  },
  {
    name: 'growth_record_publish',
    oneLine: '登记发布与效果回填(渠道/点赞/关注/线索/金额)，用于素材分与 ROI',
    when: '用户说某条内容已经发布、或要回填效果数据时',
    confirm: true,
    needsContent: true,
    params: {
      channel: {
        type: 'enum',
        enum: ['wxMoments', 'wxGroup', 'wxChat', 'douyin', 'xhs', 'other'],
        required: true,
        desc: '发布渠道'
      },
      outputId: { type: 'number', desc: '归因的产出 id（可空）' },
      likes: { type: 'number', desc: '点赞数' },
      follows: { type: 'number', desc: '新增关注' },
      leads: { type: 'number', desc: '线索数' },
      amount: { type: 'number', desc: '成交金额' },
      contentId: { type: 'number', desc: '素材 id（不传用当前任务素材）' }
    }
  }
]

export function findGrowthToolMeta(name: string): GrowthToolMeta | undefined {
  return GROWTH_TOOL_META.find((t) => t.name === name)
}
