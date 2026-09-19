/**
 * 营销域 13 个工具的实现（ToolDef 形态）。
 *
 * 为什么这么拆：能力注册表要「一份声明」同时驱动目录、审批与 AI SDK 三处 ——
 * 元数据在 ./toolMeta.ts（纯数据，可离线自检），实现在本文件，AI SDK 适配在 ./growthTools.ts。
 * 工具体与原实现逐字一致，只做了三处机械改写：
 *   1. ctx.contentId/taskId/storeId → contentIdOf(args)/taskIdOf(args)/storeIdOf(args)
 *      （默认值由 growthToolDefs(defaults) 注入：营销页传当前任务，其它入口显式传 contentId）；
 *   2. 去掉工具内的 approve(...) —— 审批改由 confirm:true + 调用方统一走审批桥；
 *   3. 参数类型由 toolMeta 声明生成（argsIn → args 断言），工具体一字未改。
 */

import type { ToolDef } from '../../ai/chat/skills'
import { GROWTH_TOOL_META, type GrowthToolMeta } from './toolMeta'
/**
 * 营销 AI 工作台工具组: 只读(素材/门店/搜索) + 写入(改写/生图/产出/导出/回填, 需审批)。
 * 工具是模型与产品能力的唯一接口; 写操作一律经 requestToolApproval。
 */

import { clipValue } from '../../../util/text'
import { createAiProvider } from '../../ai/provider'
import { describeModelError } from '../../ai/modelErrors'
import {
  countGeneratedSince,
  getAssetById,
  getContentDetail,
  insertAsset
} from '../../../db/repos/growthRepo'
import type { GrowthAsset } from '../../../../shared/growth'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getGrowthMediaDir } from '../../paths'
import { buildCoverHtml } from '../cover/templates'
import { renderHtmlToPng } from '../cover/renderer'
import {
  addOutputAsset,
  createOutput,
  getBrandProfile,
  listStores,
  removeOutputAssetsByRole,
  saveStore,
  setOutputStatus,
  updateOutputFields
} from '../../../db/repos/growthAiRepo'
import { downloadMediaAssets } from '../collector/media/assetStore'
import { readBaseAsText } from '../../lark/api'
import { searchImages, searchWeb } from './searchProvider'
import {
  generateImages,
  graySignature,
  ImageSetupError,
  loadImageReference,
  storeImageBuffer,
  type ImageReference
} from './imageProvider'
import { looksLikeEcho } from './imageSimilarity'
import {
  buildImageStrategy,
  formatStrategy,
  hasVisualFacts,
  normalizePlatform,
  parseSize,
  readVisualFacts,
  PLATFORM_SPECS
} from './imageStrategy'
import { getImageConfig } from './config'
import { exportPublishPackage } from '../publisher/exporter'
import { recordPublish } from '../remix/service'
import { checkComplianceBatch } from '../remix/compliance'

export interface GrowthToolCtx {
  sessionId: number
  taskId: number
  contentId: number
  storeId: number | null
}

/** 把本地资产读成 data URI（封面底图必须内联，离屏页面不读本地路径） */
async function assetToDataUri(asset: GrowthAsset): Promise<string> {
  if (!asset.relPath) return ''
  try {
    const buf = await readFile(join(getGrowthMediaDir(), asset.relPath))
    if (buf.length === 0) return ''
    return 'data:' + (asset.mime || 'image/png') + ';base64,' + buf.toString('base64')
  } catch {
    return ''
  }
}

/** 本月起点的毫秒时间戳（月度生图额度按自然月算） */
function monthStartTs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), 1).getTime()
}

const STYLE_HINT: Record<string, string> = {
  tanDian: '探店种草风(体验感/画面感)',
  shangXin: '上新官宣(干脆有力)',
  cuXiao: '优惠促单(突出划算)',
  renShe: '老板人设(真实松弛)',
  auto: '沿用素材原有风格'
}

export function itemBrief(contentId: number): string {
  const d = getContentDetail(contentId)
  if (!d) return '素材不存在'
  const lines: string[] = []
  lines.push('标题: ' + (d.title || '(无)'))
  if (d.text) lines.push('正文: ' + d.text.slice(0, 600))
  lines.push('平台: ' + d.origin + ' · 类型: ' + (d.kind === 'video' ? '视频' : '图文'))
  lines.push(
    '互动: 赞' +
      String(d.interactions.likes) +
      ' 藏' +
      String(d.interactions.collects) +
      ' 评' +
      String(d.interactions.comments)
  )
  // 带上 assetId：图生图的参考图、封面底图都要显式指定 assetId，
  // 不把 id 给模型，它就只能瞎猜（以前这里只有张数）
  const localImgs = d.assets.filter((a) => a.kind === 'cover' || a.kind === 'image')
  lines.push(
    '本地图片: ' +
      String(localImgs.length) +
      ' 张' +
      (localImgs.length > 0
        ? '(assetId: ' +
          localImgs
            .slice(0, 4)
            .map((a) => String(a.id))
            .join('/') +
          ')'
        : '')
  )
  if (d.decomp?.structure) lines.push('拆解卡: ' + clipValue(d.decomp.structure, 700))
  else lines.push('拆解卡: 尚未生成')
  // 视觉拆解单独给一行：图生图的「保持」清单直接取自它，模型看得见这些事实，
  // 写改写要求时才不会只说「保持构图」这种没有信息量的话。
  const v = readVisualFacts(d.decomp?.visual)
  if (hasVisualFacts(v)) {
    const bits = [
      v.composition ? '构图=' + v.composition : '',
      v.camera ? '机位=' + v.camera : '',
      v.lighting ? '光线=' + v.lighting : '',
      v.colorTone ? '色调=' + v.colorTone : '',
      v.layout ? '版式留白=' + v.layout : '',
      v.subjectRatio ? '主体=' + v.subjectRatio : '',
      v.elements.length > 0 ? '元素=' + v.elements.join('/') : '',
      v.textInImage ? '图上文字=' + v.textInImage : ''
    ].filter(Boolean)
    lines.push('视觉拆解: ' + bits.join(' · '))
  } else {
    lines.push('视觉拆解: 无(旧版拆解卡或本次没读出画面维度; 图生图的「保持」只能用通用口径)')
  }
  return lines.join('\n')
}

/**
 * 品牌资料包（growth_brand_profile）摘要。
 *
 * 为什么要有它：这张表此前**只被 UI 读写**，AI 侧一次都没读过 —— 用户在「品牌资料包」
 * 里认真填的定位与语气，对模型完全不存在。品牌口径要进文案、也要进生图提示词。
 */
export function brandBrief(): string {
  const b = getBrandProfile()
  if (!b) return '尚未配置品牌资料包: 可到 营销 → 设置 → 门店与品牌档案 填写定位与语气'
  const name = (b.name ?? '').trim()
  const raw = (b.profile ?? '').trim()
  if (!raw) return name ? '品牌: ' + name : '品牌资料包为空'
  let text = raw
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      const parts: string[] = []
      const put = (k: string, label: string): void => {
        const v = obj[k]
        if (v === undefined || v === null || v === '') return
        const s = Array.isArray(v) ? v.map((x) => String(x)).join('、') : String(v)
        if (s.trim()) parts.push(label + ': ' + s.trim())
      }
      put('positioning', '定位')
      put('position', '定位')
      put('tone', '语气')
      put('visualStyle', '视觉风格')
      put('palette', '主色调')
      put('sellingPoints', '卖点')
      put('avoidWords', '避免用词')
      if (parts.length > 0) text = parts.join('; ')
    }
  } catch {
    /* 纯文本资料包：原样用 */
  }
  return (name ? '品牌: ' + name + '\n' : '') + clipValue(text, 600)
}

export function storeBrief(storeId: number | null): string {
  const stores = listStores()
  const s = storeId ? stores.find((x) => x.id === storeId) : stores.find((x) => x.enabled)
  if (!s) return '尚未配置门店档案: 请在 营销 → 设置 → 门店与品牌档案 中填写'
  const lines: string[] = []
  lines.push('品牌: ' + (s.brandName || s.name))
  lines.push(
    '门店: ' + s.name + (s.city ? ' · ' + s.city : '') + (s.bizType ? ' · ' + s.bizType : '')
  )
  if (s.address) lines.push('地址: ' + s.address)
  try {
    const p = JSON.parse(s.profile || '{}') as Record<string, unknown>
    for (const k of [
      'phone',
      'hours',
      'avgPrice',
      'signatureDishes',
      'packages',
      'parking',
      'privateRoom',
      'tone',
      'bannedWords',
      'sellingPoints',
      'note'
    ]) {
      const v = p[k]
      if (v === undefined || v === null || v === '') continue
      lines.push(k + ': ' + clipValue(v, 300))
    }
  } catch {
    /* ignore */
  }
  if (s.poi && s.poi !== '[]') lines.push('POI: ' + clipValue(s.poi, 200))
  return lines.join('\n')
}

function modelText(system: string, user: string): Promise<string> {
  const provider = createAiProvider('growth-ai')
  if (!provider) throw new Error('AI 通道未配置: 请到 设置 → AI 助手 配置模型')
  return provider.complete(system, user, { maxTokens: 1600 })
}

function parseJson(raw: string): Record<string, unknown> | null {
  const i = raw.indexOf('{')
  if (i < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let k = i; k < raw.length; k += 1) {
    const ch = raw[k]
    if (inStr) {
      if (esc) esc = false
      else if (ch === '\\') esc = true
      else if (ch === '"') inStr = false
      continue
    }
    if (ch === '"') inStr = true
    else if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        try {
          return JSON.parse(raw.slice(i, k + 1)) as Record<string, unknown>
        } catch {
          return null
        }
      }
    }
  }
  return null
}

/** 营销页当前的上下文（作为参数默认值） */
export interface GrowthToolDefaults {
  taskId?: number
  contentId?: number
  storeId?: number | null
}

const META = new Map(GROWTH_TOOL_META.map((m) => [m.name, m]))
function metaOf(name: string): GrowthToolMeta {
  const m = META.get(name)
  if (!m) throw new Error('缺少工具元数据: ' + name)
  return m
}

export function growthToolDefs(defaults: GrowthToolDefaults = {}): ToolDef[] {
  const contentIdOf = (args: Record<string, unknown>): number =>
    Number(args?.contentId ?? defaults.contentId ?? 0)
  const taskIdOf = (args: Record<string, unknown>): number =>
    Number(args?.taskId ?? defaults.taskId ?? 0)
  const storeIdOf = (args: Record<string, unknown>): number | null => {
    const v = args?.storeId ?? defaults.storeId
    return v === undefined || v === null || v === 0 ? null : Number(v)
  }
  /** 需要素材上下文但调用方没给（例如从注册表裸调）→ 给可行动提示 */
  const needContentGuard = (args: Record<string, unknown>): string | null =>
    contentIdOf(args) > 0 ? null : '请提供 contentId（当前会话没有绑定营销任务）'
  return [
    {
      name: 'growth_read_material',
      kind: 'builtin',
      needsWx: false,
      params: metaOf('growth_read_material').params,
      description: '读取当前任务素材的标题/正文/互动/本地图片数量与 AI 拆解卡。爆改前先读它。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { contentId?: number }
        const miss = needContentGuard(args)
        if (miss) return miss
        return itemBrief(contentIdOf(args))
      }
    },
    {
      name: 'growth_get_store',
      kind: 'builtin',
      needsWx: false,
      params: metaOf('growth_get_store').params,
      description:
        '读取当前门店档案与品牌资料包(城市/地址/电话/营业时间/招牌菜/套餐/语气/品牌定位与视觉风格)。缺失字段必须追问用户, 严禁编造。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { storeId?: number }
        return storeBrief(args.storeId ?? storeIdOf(args)) + '\n【品牌资料包】\n' + brandBrief()
      }
    },
    {
      name: 'growth_search_web',
      kind: 'builtin',
      needsWx: false,
      params: metaOf('growth_search_web').params,
      description:
        '联网搜索公开信息(门店地址/电话/营业时间/菜品做法/口碑等)。结果仅供参考, 地址电话价格必须让用户确认后才能写入档案。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { query: string; count?: number }
        try {
          const rows = await searchWeb(args.query, { count: args.count ?? 6 })
          if (rows.length === 0) return '没有找到相关结果, 换个说法再试。'
          return rows
            .map(
              (r, i) =>
                String(i + 1) +
                '. ' +
                r.title +
                ' | ' +
                r.site +
                '\n   ' +
                r.snippet +
                '\n   ' +
                r.url
            )
            .join('\n')
        } catch (e) {
          return '搜索失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
    },
    {
      name: 'growth_search_images',
      kind: 'builtin',
      needsWx: false,
      params: metaOf('growth_search_images').params,
      description: '联网检索图片(菜品/环境参考图)。结果只作参考, 不得直接用于对外发布(版权)。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { query: string; count?: number }
        try {
          const rows = await searchImages(args.query, { count: args.count ?? 8 })
          if (rows.length === 0) return '没有找到相关图片。'
          return rows.map((r, i) => String(i + 1) + '. ' + r.source + ' | ' + r.url).join('\n')
        } catch (e) {
          return '图片检索失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
    },
    {
      name: 'growth_read_lark_base',
      kind: 'builtin',
      needsWx: false,
      params: metaOf('growth_read_lark_base').params,
      description:
        '读取飞书多维表格(Base)内容(只读)。用于读取运营在飞书里维护的选品表/排期表/门店清单/素材台账: ' +
        '不带 table_id 先返回该 Base 的数据表清单, 带上 table_id 再返回该表的记录(默认 30 条)。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { url?: string; table_id?: string; view_id?: string; limit?: number }
        try {
          return await readBaseAsText({
            url: args.url,
            tableId: args.table_id,
            viewId: args.view_id,
            limit: args.limit ?? 30
          })
        } catch (e) {
          return '读取飞书表格失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
    },
    {
      name: 'growth_gen_image',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_gen_image').params,
      description:
        'AI 出图(封面/氛围图/菜品示意图)。两种模式由「生图策略」自动切换: 不给参考图 = 凭描述生成; ' +
        '给 referenceAssetId = **在参考图上改写**(保持构图机位光线, 把菜品/场景/门店换成档案里的本店信息) —— ' +
        '做「照这条爆款图出我们店版本」时用后者。提示词由策略层拼装, 你只给主体描述或本次改写要求即可。结果作为候选图待用户点选。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          prompt?: string
          template?: string
          platform?: string
          count?: number
          role?: 'cover' | 'image'
          referenceAssetId?: number
          contentAssetId?: number
          contentId?: number
          taskId?: number
        }
        const miss = needContentGuard(args)
        if (miss) return miss
        const cfg = getImageConfig()
        const storeId = storeIdOf(args)
        const store = storeId
          ? (listStores().find((s) => s.id === storeId) ?? null)
          : (listStores().find((s) => s.enabled) ?? null)
        // 参考图先取：模式（生成 / 在参考图上改写）由它决定。
        // 顺序即语义：第 1 张 = 结构模板（原爆款图，只借构图），第 2 张 = 本店实拍（内容以它为准）。
        const refs: ImageReference[] = []
        let refNote = ''
        if (args.referenceAssetId) {
          const r = await loadImageReference(args.referenceAssetId)
          if (r) refs.push(r)
          else
            refNote =
              '（注意：结构参考图 assetId=' +
              String(args.referenceAssetId) +
              ' 取不到本地文件，本次按纯文本生成）'
        }
        if (args.contentAssetId) {
          const c = await loadImageReference(args.contentAssetId)
          if (c) refs.push(c)
          else
            refNote =
              '（注意：内容参考图 assetId=' +
              String(args.contentAssetId) +
              ' 取不到本地文件，本次只用结构参考图）'
        }
        // 结构参考图的视觉拆解：只在该图确实属于当前素材时采用 —— 把 A 素材的构图事实
        // 套到 B 素材的参考图上，会让「保持」写的是另一张图，比不给更糟。
        const detail = getContentDetail(contentIdOf(args))
        const refIsOwnAsset =
          !!detail &&
          !!args.referenceAssetId &&
          detail.assets.some((a) => a.id === args.referenceAssetId)
        const referenceVisual = refIsOwnAsset ? detail?.decomp?.visual : null
        // 策略层：模板选择 + 平台比例 + 门店事实 + 品牌资料包 + 月度额度 → prompt/negative/size/count
        const strategy = buildImageStrategy({
          mode: refs.length > 0 ? 'edit' : 'gen',
          referenceCount: refs.length,
          referenceVisual,
          userPrompt: args.prompt ?? '',
          platform: args.platform || cfg.platform,
          role: args.role ?? 'cover',
          templateId: args.template,
          count: args.count,
          maxCount: cfg.count,
          monthlyLimit: cfg.monthlyLimit,
          usedThisMonth: countGeneratedSince(monthStartTs()),
          templateLibraryRaw: cfg.templates,
          size: cfg.size,
          store,
          brand: getBrandProfile(),
          materialHint: itemBrief(contentIdOf(args))
        })
        // 月度额度用尽：在**发起请求前**拦下（接口不会拦，它只会照单生成然后计费）
        if (strategy.blocked) return strategy.blockedReason ?? '本月生图额度已用尽'
        try {
          const gen = await generateImages({
            contentId: contentIdOf(args),
            prompt: strategy.prompt,
            negative: strategy.negative,
            count: strategy.count,
            size: strategy.size,
            references: refs
          })
          const imgs = gen.images
          // 图生图的隐蔽失败：返回 200 但画面几乎没变（模型没接受改写，或通道把输入原样回传）。
          // 拿产物与结构参考图比一次灰度签名，疑似就如实说 —— 否则用户会以为"爆改"成功了。
          let echoNote = ''
          if (gen.usedReference && refs.length > 0 && imgs.length > 0) {
            const refSig = graySignature(refs[0].data)
            let echoCount = 0
            for (const g of imgs) {
              try {
                const buf = await readFile(join(getGrowthMediaDir(), g.relPath))
                if (looksLikeEcho(refSig, graySignature(buf))) echoCount++
              } catch {
                /* 读不到就不比，不因此报错 */
              }
            }
            if (echoCount > 0) {
              echoNote =
                '（⚠ ' +
                String(echoCount) +
                ' 张结果与结构参考图几乎一致，疑似图生图**没生效**（模型可能直接回传了原图）——' +
                '建议重试，或把要求写得更具体/换模型）'
            }
          }
          if (gen.warning) refNote = '（注意：' + gen.warning + '）'
          else if (gen.usedReference) {
            refNote =
              '（已在 ' +
              String(gen.referenceCount) +
              ' 张参考图上改写：保持' +
              (gen.referenceCount > 1 ? '图1 的构图' : '构图') +
              (strategy.visualLocked ? '/机位/光线/留白（按该素材的视觉拆解逐项锁定）' : '') +
              '，内容换成' +
              (gen.referenceCount > 1 ? '图2 的本店实拍 + ' : '') +
              '门店档案里的真实信息）' +
              (strategy.visualLocked
                ? ''
                : '（这条素材还没有视觉拆解，构图只能靠模型自己看图猜）') +
              echoNote
          }
          const explicitTemplate = args.template !== undefined && args.template !== 'auto'
          const outputId = createOutput({
            taskId: taskIdOf(args),
            contentId: contentIdOf(args),
            variant: 'chat:image',
            title: '',
            copy: '',
            complianceHints: [],
            meta: {
              prompt: strategy.finalPrompt,
              source: 'gen',
              // 落库「为什么这么生成」：换人接手/复盘时不用再猜这张图是按什么策略来的
              strategy: {
                templateId: strategy.templateId,
                templateLabel: strategy.templateLabel,
                platform: strategy.platform,
                platformLabel: strategy.platformLabel,
                ratio: strategy.ratio,
                role: strategy.role,
                size: strategy.size,
                count: strategy.count,
                mode: strategy.mode,
                explicitTemplate,
                referenceAssetId: args.referenceAssetId ?? null,
                contentAssetId: args.contentAssetId ?? null,
                usedReference: gen.usedReference,
                referenceCount: gen.referenceCount,
                notes: strategy.notes
              }
            },
            status: 'candidate'
          })
          const refTag = gen.usedReference
            ? ' · 参考图 ' +
              String(gen.referenceCount) +
              ' 张(结构 assetId=' +
              String(args.referenceAssetId) +
              (args.contentAssetId ? '，内容 assetId=' + String(args.contentAssetId) : '') +
              ')'
            : ''
          for (const g of imgs) {
            addOutputAsset({
              outputId,
              assetId: g.assetId,
              role: strategy.role,
              source: 'gen',
              prompt: strategy.finalPrompt,
              note: g.note + ' · ' + formatStrategy(strategy) + refTag
            })
          }
          const warn = strategy.warning ? '（注意：' + strategy.warning + '）' : ''
          // 实际张数少于计划 = 被月度额度压过，要如实说明（否则用户只看到"少给了"）
          const shortNote =
            imgs.length < strategy.count
              ? '（本月额度不足，按 ' + String(imgs.length) + ' 张生成）'
              : ''
          return (
            '已生成 ' +
            String(imgs.length) +
            ' 张候选图(outputId=' +
            String(outputId) +
            ')。策略: ' +
            formatStrategy(strategy) +
            shortNote +
            refNote +
            '；已标注示意图。请在右侧图片卡点「用这张」(只采用选中的那一张)。' +
            warn
          )
        } catch (e) {
          if (e instanceof ImageSetupError) return e.message
          return '生图失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
    },
    {
      name: 'growth_make_cover',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_make_cover').params,
      description:
        '把标题合成到实拍图上做封面（大字排版 + 折行 + 缩字号，模板可选）。纯本地渲染：不调用生图接口、不占每月张数。底图默认取素材里第一张本地图。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          title?: string
          subtitle?: string
          badge?: string
          template?: string
          platform?: string
          assetId?: number
          outputId?: number
          contentId?: number
          taskId?: number
        }
        const miss = needContentGuard(args)
        if (miss) return miss
        const title = (args.title ?? '').trim()
        if (!title) return '请给出封面标题（通常直接用采纳的那条标题）。'
        const contentId = contentIdOf(args)
        const cfg = getImageConfig()
        const platform = normalizePlatform(args.platform || cfg.platform)
        const spec = PLATFORM_SPECS[platform]
        // 与生图同一套尺寸口径：设置里显式填了尺寸就听它的，否则按平台
        const sizeStr = cfg.size && parseSize(cfg.size) ? cfg.size : spec.size
        const wh = parseSize(sizeStr) ?? { width: 1024, height: 1024 }

        // 底图：显式 assetId 优先，否则用素材里第一张本地图
        let asset: GrowthAsset | null = null
        if (args.assetId) {
          asset = getAssetById(args.assetId)
          if (!asset) return '底图 assetId=' + String(args.assetId) + ' 不存在。'
        } else {
          const detail = getContentDetail(contentId)
          asset =
            detail?.assets.find((a) => (a.kind === 'cover' || a.kind === 'image') && !!a.relPath) ??
            null
        }
        let imageDataUri = ''
        if (asset) {
          const dataUri = await assetToDataUri(asset)
          if (!dataUri) return '底图读取失败(本地文件缺失)，换一张门店实拍图再试。'
          imageDataUri = dataUri
        }

        try {
          const doc = buildCoverHtml({
            templateId: args.template,
            title,
            subtitle: args.subtitle ?? '',
            badge: args.badge ?? '',
            imageDataUri,
            width: wh.width,
            height: wh.height
          })
          const png = await renderHtmlToPng(doc.html, { width: wh.width, height: wh.height })
          const stored = await storeImageBuffer(
            png,
            'image/png',
            contentId,
            doc.lines.join('\n'),
            sizeStr,
            'cover:composite'
          )
          const noteParts = [
            '封面合成',
            doc.templateLabel,
            spec.label + ' ' + String(wh.width) + 'x' + String(wh.height),
            doc.usedImage ? '实拍底图' : '纯文字'
          ]
          const note = noteParts.join(' · ')
          if (args.outputId) {
            removeOutputAssetsByRole(args.outputId, 'cover')
            addOutputAsset({
              outputId: args.outputId,
              assetId: stored.assetId,
              role: 'cover',
              source: 'cover',
              prompt: doc.lines.join(' / '),
              note
            })
            return (
              '已生成封面并设为产出 #' +
              String(args.outputId) +
              ' 的封面(' +
              note +
              '；底图 assetId=' +
              String(asset?.id ?? 0) +
              ')。'
            )
          }
          const outputId = createOutput({
            taskId: taskIdOf(args),
            contentId,
            variant: 'chat:cover',
            title: '',
            copy: '',
            complianceHints: [],
            meta: {
              source: 'cover',
              prompt: doc.lines.join(' / '),
              strategy: {
                templateId: doc.templateId,
                templateLabel: doc.templateLabel,
                platform,
                platformLabel: spec.label,
                size: sizeStr,
                lines: doc.lines,
                usedImage: doc.usedImage,
                notes: [note]
              }
            },
            status: 'candidate'
          })
          addOutputAsset({
            outputId,
            assetId: stored.assetId,
            role: 'cover',
            source: 'cover',
            prompt: doc.lines.join(' / '),
            note
          })
          return (
            '已生成封面候选(outputId=' +
            String(outputId) +
            '，' +
            note +
            ')。请在右侧图片卡点「用这张」采用。'
          )
        } catch (e) {
          return '封面生成失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
    },
    {
      name: 'growth_rewrite_title',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_rewrite_title').params,
      description: '生成标题候选(3-5 条)。只生成候选, 用户点选后才写入产出。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          strategy?: string
          style?: string
          contentId?: number
          taskId?: number
          storeId?: number
        }
        const miss = needContentGuard(args)
        if (miss) return miss
        const system = [
          '你是餐饮门店内容运营。基于素材与门店事实, 生成 5 条全新原创标题。',
          '规则: 不得复述素材原句; 不虚构门店事实(缺失用占位符【菜品】【地址】等); 不用绝对化用语与功效宣称;',
          '只输出 JSON: { "titles": ["...", "..."] }',
          '风格: ' + STYLE_HINT[args.style ?? 'auto']
        ].join('\n')
        const user =
          '素材:\n' +
          itemBrief(contentIdOf(args)) +
          '\n\n门店事实:\n' +
          storeBrief(storeIdOf(args)) +
          (args.strategy ? '\n\n要求: ' + args.strategy : '')
        try {
          const parsed = parseJson(await modelText(system, user))
          const titles = Array.isArray(parsed?.['titles'])
            ? (parsed?.['titles'] as unknown[])
                .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
                .slice(0, 6)
            : []
          if (titles.length === 0) return '模型未返回可用标题, 请重试或换个说法。'
          const outputId = createOutput({
            taskId: taskIdOf(args),
            contentId: contentIdOf(args),
            variant: 'chat:title',
            title: titles.join('\n'),
            copy: '',
            complianceHints: checkComplianceBatch(titles),
            meta: { strategy: args.strategy ?? '', style: args.style ?? 'auto' },
            status: 'candidate'
          })
          return (
            '已生成 ' +
            String(titles.length) +
            ' 条候选标题(outputId=' +
            String(outputId) +
            '):\n' +
            titles.map((t, i) => String(i + 1) + '. ' + t).join('\n')
          )
        } catch (e) {
          return (
            '生成失败: ' + (describeModelError(e) || (e instanceof Error ? e.message : String(e)))
          )
        }
      }
    },
    {
      name: 'growth_rewrite_copy',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_rewrite_copy').params,
      description: '生成/改写正文候选(1-3 篇)。只生成候选, 用户点选后才写入产出。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          instruction?: string
          style?: string
          copies?: number
          contentId?: number
          taskId?: number
          storeId?: number
        }
        const miss = needContentGuard(args)
        if (miss) return miss
        const n = Math.min(Math.max(args.copies ?? 2, 1), 3)
        const system = [
          '你是餐饮门店内容运营。基于素材与门店事实, 写 ' +
            String(n) +
            ' 篇全新原创正文(每篇 80-180 字)。',
          '规则: 只借鉴结构与情绪, 不复述原句; 不虚构门店事实(缺失用占位符); 不用绝对化用语与食品功效宣称;',
          '只输出 JSON: { "copies": ["正文1", "正文2"] }',
          '风格: ' + STYLE_HINT[args.style ?? 'auto']
        ].join('\n')
        const user =
          '素材:\n' +
          itemBrief(contentIdOf(args)) +
          '\n\n门店事实:\n' +
          storeBrief(storeIdOf(args)) +
          (args.instruction ? '\n\n改写要求: ' + args.instruction : '')
        try {
          const parsed = parseJson(await modelText(system, user))
          const copies = Array.isArray(parsed?.['copies'])
            ? (parsed?.['copies'] as unknown[])
                .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
                .slice(0, 3)
            : []
          if (copies.length === 0) return '模型未返回可用正文, 请重试。'
          const ids: number[] = []
          copies.forEach((c, i) => {
            ids.push(
              createOutput({
                taskId: taskIdOf(args),
                contentId: contentIdOf(args),
                variant: 'chat:copy' + String(i + 1),
                title: '',
                copy: c,
                complianceHints: checkComplianceBatch([c]),
                meta: { instruction: args.instruction ?? '', style: args.style ?? 'auto' },
                status: 'candidate'
              })
            )
          })
          return (
            '已生成 ' +
            String(copies.length) +
            ' 篇候选正文(outputId=' +
            ids.join(',') +
            ')。请在右侧产出面板点选。'
          )
        } catch (e) {
          return (
            '生成失败: ' + (describeModelError(e) || (e instanceof Error ? e.message : String(e)))
          )
        }
      }
    },
    {
      name: 'growth_update_output',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_update_output').params,
      description: '把用户选定的候选写入产出, 或直接修改产出文本。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          outputId: number
          title?: string
          copy?: string
          status?: 'selected' | 'archived'
        }
        updateOutputFields(args.outputId, { title: args.title, copy: args.copy })
        if (args.status) setOutputStatus(args.outputId, args.status)
        return '已更新产出 #' + String(args.outputId) + '。'
      }
    },
    {
      name: 'growth_replace_image',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_replace_image').params,
      description:
        '替换产出图集(按 role 顶替, 旧图会被移除而不是叠加): 用门店素材(assetId)、候选生成图(assetId)或联网图片(remoteUrl, 需确认版权)。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          outputId: number
          assetId?: number
          remoteUrl?: string
          role?: 'cover' | 'image'
          contentId?: number
        }
        const miss = needContentGuard(args)
        if (miss) return miss
        const role = args.role === 'cover' ? 'cover' : 'image'
        if (args.assetId) {
          const dropped = removeOutputAssetsByRole(args.outputId, role)
          addOutputAsset({
            outputId: args.outputId,
            assetId: args.assetId,
            role,
            source: 'store',
            prompt: '',
            note: ''
          })
          return (
            '已替换为本地素材(assetId=' +
            String(args.assetId) +
            '，位置: ' +
            (role === 'cover' ? '封面' : '正文图') +
            (dropped > 0 ? '，已顶掉原有 ' + String(dropped) + ' 张)' : ')')
          )
        }
        if (args.remoteUrl) {
          const dl = await downloadMediaAssets([args.remoteUrl], 'web', 1)
          if (dl.ok.length === 0) return '图片下载失败(可能防盗链), 建议改用门店实拍或 AI 生图。'
          const assetId = insertAsset({
            contentId: contentIdOf(args),
            kind: args.role === 'cover' ? 'cover' : 'image',
            mime: dl.ok[0].mime,
            size: dl.ok[0].size,
            relPath: dl.ok[0].relPath,
            sourceMark: 'search:web'
          })
          removeOutputAssetsByRole(args.outputId, role)
          addOutputAsset({
            outputId: args.outputId,
            assetId,
            role,
            source: 'search',
            prompt: '',
            note: '来源: 联网检索(请确认版权后再发布)'
          })
          return (
            '已下载并替换为联网图片(assetId=' +
            String(assetId) +
            '), 已标注来源, 发布前请确认版权。'
          )
        }
        return '请提供 assetId 或 remoteUrl。'
      }
    },
    {
      name: 'growth_save_store_fact',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_save_store_fact').params,
      description: '把已确认的门店事实写入门店档案(联网查到的事实必须先经用户确认)。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { storeId?: number; key: string; value: string }
        const id = args.storeId ?? storeIdOf(args)
        const s = id ? listStores().find((x) => x.id === id) : listStores().find((x) => x.enabled)
        if (!s) return '没有可更新的门店档案, 请先在 营销 → 设置 → 门店与品牌档案 中创建。'
        let profile: Record<string, unknown> = {}
        try {
          profile = JSON.parse(s.profile || '{}') as Record<string, unknown>
        } catch {
          profile = {}
        }
        profile[args.key] = args.value
        saveStore({
          id: s.id,
          brandName: s.brandName,
          name: s.name,
          city: args.key === 'city' ? args.value : s.city,
          address: args.key === 'address' ? args.value : s.address,
          bizType: s.bizType,
          poi: s.poi,
          profile: JSON.stringify(profile),
          enabled: s.enabled
        })
        return '已写入门店档案: ' + args.key + ' = ' + args.value
      }
    },
    {
      name: 'growth_export_package',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_export_package').params,
      description: '导出当前任务的发布包(文案 + 图集 + 视频链接)到用户选择的目录。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as { outputIds?: number[]; contentId?: number }
        const miss = needContentGuard(args)
        if (miss) return miss
        const res = await exportPublishPackage(contentIdOf(args), args.outputIds ?? [])
        return res.ok
          ? '已导出到: ' + String(res.dir) + ' (' + String(res.files) + ' 个文件)'
          : '导出失败: ' + String(res.error)
      }
    },
    {
      name: 'growth_record_publish',
      kind: 'builtin',
      needsWx: false,
      confirm: true,
      params: metaOf('growth_record_publish').params,
      description: '登记发布与效果回填(渠道/点赞/新增关注/线索/金额), 用于素材分与 ROI 统计。',
      run: async (_ctx, argsIn) => {
        const args = argsIn as {
          channel: 'wxMoments' | 'wxGroup' | 'wxChat' | 'douyin' | 'xhs' | 'other'
          outputId?: number
          likes?: number
          follows?: number
          leads?: number
          amount?: number
          contentId?: number
        }
        const miss = needContentGuard(args)
        if (miss) return miss
        try {
          const r = recordPublish(contentIdOf(args), {
            channel: args.channel,
            likes: args.likes ?? 0,
            collects: 0,
            comments: 0,
            shares: 0,
            follows: args.follows ?? 0,
            leads: args.leads ?? 0,
            amount: args.amount ?? 0,
            outputId: args.outputId ?? null
          })
          return '已登记发布, 素材分更新为 ' + String(r.score) + '。'
        } catch (e) {
          return '登记失败: ' + (e instanceof Error ? e.message : String(e))
        }
      }
    }
  ]
}
