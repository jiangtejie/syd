import { buildSync } from 'esbuild'
import { createRequire } from 'module'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { fileURLToPath } from 'url'

/**
 * 生图策略自检（纯函数，不碰库、不碰文件系统、不联网）。
 *
 * 为什么必须有：策略错了不会报错 —— 表现只是「图不对/不像本店/比例作废」。
 * 尤其钉住三件真出过问题的：
 *  ① **品牌资料包必须真的进 prompt**：此前 growth_brand_profile 存了、UI 也让人填，
 *     但 AI 侧从来没读过（生图只看模板 + 用户一句话），等于白存；
 *  ② **平台比例必须按平台给**：以前只有一个全局 size，默认 1024x1024 正方形，
 *     小红书竖版封面直接构图作废；
 *  ③ **门店事实只能来自档案**：负向词要把门店禁用词带上，事实不能被构图要求挤掉。
 */
const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'dsh-growth-imgstrategy-'))

let failed = 0
const ok = (cond, label, extra = '') => {
  console.log((cond ? '  ✔ ' : '  ✖ ') + label + (extra ? ' — ' + extra : ''))
  if (!cond) failed++
}

try {
  const bundle = join(work, 'imageStrategy.cjs')
  buildSync({
    entryPoints: [join(root, 'src/main/services/growth/ai/imageStrategy.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: bundle
  })
  const S = require(bundle)
  const {
    PLATFORM_SPECS,
    BUILTIN_IMAGE_TEMPLATES,
    UNIVERSAL_NEGATIVE,
    normalizePlatform,
    normalizeRole,
    parseSize,
    composeFinalPrompt,
    parseTemplateLibrary,
    pickTemplate,
    readBrandStyle,
    readStoreVisualFacts,
    readVisualFacts,
    hasVisualFacts,
    buildImageStrategy,
    formatStrategy
  } = S

  console.log('平台规格：')
  ok(
    normalizePlatform('xhs') === 'xhs' && normalizePlatform('') === 'xhs',
    '未知/空平台回落默认（小红书）'
  )
  ok(
    normalizePlatform('douyin') === 'douyin' && normalizePlatform('MOMENTS') === 'moments',
    '平台名大小写不敏感'
  )
  ok(
    PLATFORM_SPECS.xhs.size === '1024x1536',
    '小红书给竖版尺寸（不是 1024x1024 方图）',
    PLATFORM_SPECS.xhs.size
  )
  ok(PLATFORM_SPECS.douyin.size === '1024x1536', '抖音给竖版尺寸', PLATFORM_SPECS.douyin.size)
  ok(PLATFORM_SPECS.moments.size === '1024x1024', '朋友圈方版', PLATFORM_SPECS.moments.size)
  ok(
    Object.values(PLATFORM_SPECS).every(
      (p) => /^\d+x\d+$/.test(p.size) && p.ratio.length > 0 && p.framing.length > 10
    ),
    '每个平台都有可用尺寸 + 比例 + 构图要求'
  )
  ok(
    normalizeRole('cover') === 'cover' &&
      normalizeRole(undefined) === 'image' &&
      normalizeRole('COVER') === 'cover',
    '角色归一化'
  )

  console.log('尺寸解析：')
  ok(
    parseSize('1024x1536').width === 1024 && parseSize('1024x1536').height === 1536,
    '合法尺寸解析出宽高'
  )
  ok(parseSize(' 1080 X 1440 ')?.height === 1440, '容忍空格与大小写')
  ok(
    parseSize('1024') === null && parseSize('abc') === null && parseSize('') === null,
    '非法尺寸一律 null（不静默塞个错值）'
  )
  ok(parseSize('0x100') === null, '零宽不算合法尺寸')

  console.log('模板库：')
  ok(BUILTIN_IMAGE_TEMPLATES.length === 4, '内置 4 个模板', String(BUILTIN_IMAGE_TEMPLATES.length))
  ok(
    ['dish', 'store', 'cover', 'people'].every((id) =>
      BUILTIN_IMAGE_TEMPLATES.some((t) => t.id === id)
    ),
    '内置模板即设计文档里的 菜品特写/门店环境/封面氛围/人物场景'
  )
  const builtinLib = parseTemplateLibrary('')
  ok(builtinLib.source === 'builtin' && builtinLib.templates.length === 4, '模板库留空 → 内置')
  const merged = parseTemplateLibrary(
    JSON.stringify([{ id: 'dish', scene: '本店招牌锅底特写，红油翻滚' }])
  )
  const mergedDish = merged.templates.find((t) => t.id === 'dish')
  ok(merged.source === 'merged' && mergedDish.scene.includes('红油翻滚'), '同 id 覆盖 scene')
  ok(mergedDish.label === '菜品特写', '只改 scene 时其余字段沿用内置（不用整条重写）')
  const added = parseTemplateLibrary(
    JSON.stringify([{ id: 'night', label: '夜宵摊', scene: '深夜路边摊烟火气' }])
  )
  ok(added.templates.length === 5 && added.templates[4].id === 'night', '新 id 追加到库尾')
  const broken = parseTemplateLibrary('{ 这不是 json')
  ok(broken.templates.length === 4 && !!broken.error, 'JSON 坏掉 → 回退内置并如实报错（不静默）')
  const plain = parseTemplateLibrary('拍一张本店招牌菜的特写')
  ok(
    plain.source === 'merged' && plain.templates[0].id === 'custom',
    '纯文本模板（用户不会写 JSON）也能用'
  )
  const badShape = parseTemplateLibrary('{"foo":1}')
  ok(badShape.templates.length === 4 && !!badShape.error, '结构不对 → 回退内置并报错')

  console.log('模板选择：')
  const tpls = BUILTIN_IMAGE_TEMPLATES
  ok(pickTemplate({ templateId: 'store', templates: tpls }).id === 'store', '显式指定模板优先')
  ok(
    pickTemplate({ role: 'cover', userPrompt: '招牌菜特写', templates: tpls }).id === 'dish',
    '点名菜品 → 菜品特写（不被角色盖过）'
  )
  ok(
    pickTemplate({ role: 'image', userPrompt: '店内环境', templates: tpls }).id === 'store',
    '点名环境 → 门店环境'
  )
  ok(
    pickTemplate({ role: 'image', userPrompt: '顾客夹菜的背影', templates: tpls }).id === 'people',
    '点名人物 → 人物场景'
  )
  ok(
    pickTemplate({ role: 'cover', templates: tpls }).id === 'cover',
    '封面角色 + 没描述 → 封面氛围'
  )
  ok(pickTemplate({ role: 'image', templates: tpls }).id === 'dish', '正文图 + 没描述 → 菜品特写')
  ok(
    pickTemplate({ templateId: '不存在', role: 'cover', templates: tpls }).id === 'cover',
    '指定了不存在的模板 → 落回角色默认（不报错卡住）'
  )

  console.log('品牌资料包 / 门店档案解析：')
  const brand = readBrandStyle(
    '{"positioning":"社区鲜货火锅","tone":"成都本地、亲切","visualStyle":"暖色木质复古","palette":["#8B3A2F","米白"],"sellingPoints":["鲜切黄牛肉"]}'
  )
  ok(
    brand.positioning === '社区鲜货火锅' && brand.tone.includes('成都'),
    'JSON 品牌资料包解析出定位与调性'
  )
  ok(brand.palette.length === 2 && brand.sellingPoints.length === 1, '解析主色调与卖点')
  ok(
    readBrandStyle('朴实、干净的社区小店').tone.includes('朴实'),
    '纯文本品牌资料包也认（当调性用）'
  )
  ok(
    readBrandStyle('').positioning === '' && readBrandStyle('').palette.length === 0,
    '空资料包 → 全空，不编造'
  )
  ok(readBrandStyle('{ 坏的').tone.length > 0, '品牌 JSON 坏掉 → 退回当纯文本，不整块失效')
  const facts = readStoreVisualFacts(
    '{"signatureDishes":"鲜切黄牛肉、百香果牛肉","packages":"双人套餐128","bannedWords":"最、第一","note":"临街两层"}',
    { city: '成都' }
  )
  ok(facts.signatureDishes.includes('鲜切黄牛肉'), '门店招牌菜解析出来')
  ok(facts.bannedWords.includes('最'), '门店禁用词解析出来（要进负向词）')
  ok(readStoreVisualFacts('', {}).signatureDishes === '', '门店档案为空 → 不编造菜品')

  console.log('策略组装（这次修复的核心：品牌资料包必须真的进 prompt）：')
  const s1 = buildImageStrategy({
    userPrompt: '招牌菜特写',
    platform: 'xhs',
    role: 'cover',
    store: {
      name: '萍姐火锅',
      brandName: '萍姐火锅',
      city: '成都',
      profile: '{"signatureDishes":"鲜切黄牛肉","bannedWords":"最"}'
    },
    brand: {
      name: '萍姐火锅',
      profile: '{"positioning":"社区鲜货火锅","tone":"成都本地、亲切","palette":["暖红"]}'
    },
    materialHint: '标题: 成都人自己的火锅'
  })
  ok(
    s1.templateId === 'dish' && s1.platform === 'xhs' && s1.role === 'cover',
    '策略选中 菜品特写 · 小红书 · 封面'
  )
  ok(s1.size === '1024x1536', '按平台给竖版尺寸', s1.size)
  ok(s1.prompt.includes('鲜切黄牛肉'), '门店招牌菜进了 prompt')
  ok(
    s1.prompt.includes('社区鲜货火锅') && s1.prompt.includes('成都本地'),
    '品牌定位与调性进了 prompt（此前完全没用上）'
  )
  ok(s1.prompt.includes('暖红'), '品牌主色调进了 prompt')
  ok(s1.prompt.includes('小红书') && s1.prompt.includes(s1.ratio), '平台构图要求进了 prompt')
  ok(s1.negative.includes('最'), '门店禁用词进了负向词')
  ok(
    s1.negative.includes('文字') && s1.negative.includes('人脸'),
    '负向词覆盖文字/水印与人脸（肖像权）'
  )
  ok(
    s1.finalPrompt.includes('【避免出现】') && s1.finalPrompt.startsWith(s1.prompt),
    'finalPrompt = 正向 + 负向（拼接方式固定）'
  )
  ok(composeFinalPrompt('a', '') === 'a', '没有负向词时不留下空壳段落')

  const iSubject = s1.prompt.indexOf('画面主体')
  const iStore = s1.prompt.indexOf('真实元素')
  const iBrand = s1.prompt.indexOf('品牌口径')
  const iPlat = s1.prompt.indexOf('平台构图')
  ok(
    iSubject >= 0 && iSubject < iStore && iStore < iBrand && iBrand < iPlat,
    '组装顺序固定：主体 → 门店事实 → 品牌口径 → 平台构图（事实不被构图挤掉）'
  )

  const s2 = buildImageStrategy({ platform: 'douyin', role: 'image' })
  ok(
    s2.prompt.includes('画面主体：') &&
      s2.prompt.includes(s2.templateLabel === '菜品特写' ? '特写' : ''),
    '没给描述时用模板骨架当主体'
  )
  ok(
    !s2.prompt.includes('真实元素') && !s2.prompt.includes('品牌口径'),
    '没有门店/品牌时不塞空行（不编造）'
  )
  ok(s2.platformLabel === '抖音' && s2.size === PLATFORM_SPECS.douyin.size, '抖音走抖音规格')

  const s3 = buildImageStrategy({ count: 9, maxCount: 2 })
  ok(s3.count === 2, '张数被「每次张数」上限压住', String(s3.count))
  ok(
    s3.notes.some((n) => n.includes('压到')),
    '被压张数要说出来（不静默）'
  )
  const s4 = buildImageStrategy({ count: 9, maxCount: 9 })
  ok(s4.count === 4, '硬上限 4 张（接口与成本两头都受不了更多）', String(s4.count))
  const s5 = buildImageStrategy({ size: '1080x1440' })
  ok(s5.size === '1080x1440', '设置里显式填了尺寸 → 以它为准（逃生口）')
  const s6 = buildImageStrategy({ size: '乱填' })
  ok(s6.size === PLATFORM_SPECS.xhs.size, '尺寸乱填 → 回落平台规格（不把脏值传给接口）')

  const s7 = buildImageStrategy({ templateLibraryRaw: '{坏的', platform: 'xhs' })
  ok(!!s7.warning && s7.templateId === 'dish', '模板库坏掉时策略仍可用，并把问题报出来')
  const s8 = buildImageStrategy({
    templateLibraryRaw: JSON.stringify([{ id: 'dish', scene: '本店红油锅底特写，辣椒翻滚' }])
  })
  ok(s8.prompt.includes('辣椒翻滚'), '自定义模板真的进了 prompt')
  ok(
    s8.notes.some((n) => n.includes('自定义模板')),
    '用了自定义模板要说清楚'
  )

  console.log('图生图（mode=edit）的 prompt 结构：')
  const e1 = buildImageStrategy({
    mode: 'edit',
    userPrompt: '把画面里的菜品换成本店的鲜切黄牛肉',
    platform: 'xhs',
    role: 'cover',
    store: { name: '萍姐火锅', brandName: '萍姐火锅', city: '成都', profile: '{"signatureDishes":"鲜切黄牛肉"}' },
    brand: { name: '萍姐火锅', profile: '{"positioning":"社区鲜货火锅","palette":["暖红"]}' }
  })
  ok(e1.mode === 'edit', '回执带 edit 模式')
  ok(
    e1.prompt.includes('【保持】') && e1.prompt.includes('【替换为本店真实信息】'),
    '三段式：保持什么 + 换成我家的，都在 prompt 里'
  )
  ok(e1.prompt.includes('参考图'), '明说以参考图为基础改图，而不是凭空生成')
  ok(!e1.prompt.includes('画面主体：'), 'edit 不说「画面主体」（那是生成式的说法，会诱导模型重画）')
  ok(e1.prompt.includes('鲜切黄牛肉') && e1.prompt.includes('暖红'), '门店与品牌事实照样进 prompt')
  ok(
    e1.negative.includes('Logo') && e1.negative.includes('文字'),
    'edit 的负向词额外要求不带出参考图的文字/Logo/水印'
  )
  ok(
    e1.negative.includes('不要照抄参考图的菜品摆盘'),
    'edit 明确禁止照抄原图，要求换成本店信息（否则「爆改」变「搬运」）'
  )
  ok(e1.prompt.includes('【保持】') && e1.prompt.indexOf('【保持】') < e1.prompt.indexOf('【替换'), '先保持后替换（顺序即契约）')
  ok(buildImageStrategy({ mode: 'gen', userPrompt: '招牌菜' }).mode === 'gen', '不传 mode 默认 gen')
  ok(buildImageStrategy({ mode: '乱填' }).mode === 'gen', '未知 mode 回落到 gen（不静默变成改写）')
  ok(buildImageStrategy({ mode: 'edit' }).prompt.includes('参考图'), 'edit 即使没有用户描述也成立')
  ok(e1.notes.some((n) => n.includes('图生图')), '策略说明里标明这是图生图')

  console.log('两张参考图（图1 结构模板 + 图2 本店实拍）：')
  const e2 = buildImageStrategy({
    mode: 'edit',
    referenceCount: 2,
    userPrompt: '把菜品换成我们店的鲜切黄牛肉',
    platform: 'xhs',
    store: { name: '萍姐火锅', brandName: '萍姐火锅', profile: '{"signatureDishes":"鲜切黄牛肉"}' }
  })
  ok(e2.prompt.includes('【图1】') && e2.prompt.includes('【图2】'), 'prompt 里把两张图各自是什么写清楚')
  ok(e2.prompt.includes('以图2 为准'), '内容以本店实拍图为准（不是以模板图为准）')
  ok(e2.prompt.includes('【保持】图1'), '「保持」指向结构模板那张（图1）')
  ok(e2.negative.includes('不要保留图1'), '负向词也指向图1，而不是笼统的「参考图」')
  ok(
    e2.notes.some((n) => n.includes('图1 结构模板') && n.includes('图2 本店实拍')),
    '策略说明里写明两张图的分工'
  )
  const single = buildImageStrategy({ mode: 'edit', referenceCount: 1 })
  ok(single.prompt.includes('【保持】参考图'), '只有一张时仍说「参考图」', '')

  console.log('视觉拆解 → 图生图的「保持」清单：')
  const visualJson = JSON.stringify({
    composition: '居中对称, 主体略偏下',
    camera: '90 度俯拍',
    lighting: '自然侧逆光, 高光在汤面',
    colorTone: '暖橙高饱和',
    layout: '上方三分之一留白压标题',
    subjectRatio: '主体占画面 60%',
    elements: ['白瓷碗', '木桌', '干冰雾气'],
    textInImage: '人均68'
  })
  const vf = readVisualFacts(visualJson)
  ok(
    vf.composition.includes('居中') && vf.camera.includes('俯拍'),
    '库里存的是 JSON 文本 → 能解析出构图与机位'
  )
  ok(vf.elements.length === 3 && vf.textInImage === '人均68', '元素清单与图上原文都读出来')
  ok(
    readVisualFacts({ composition: '三分法', tone: '冷调', objects: ['玻璃杯'] }).colorTone === '冷调',
    '容忍模型换键名（tone / objects）'
  )
  ok(
    readVisualFacts({ textInImage: '空' }).textInImage === '' &&
      readVisualFacts({ textInImage: '无' }).textInImage === '',
    '「空 / 无」不算事实（否则会写出「不要带出原文：空」）'
  )
  ok(!hasVisualFacts(readVisualFacts(null)) && !hasVisualFacts(readVisualFacts('')), '没有拆解 → 不算有视觉事实')
  ok(!hasVisualFacts({ composition: '', elements: [] }), '字段全空 → 不算有视觉事实')
  ok(readVisualFacts('{坏').composition === '', '坏 JSON 不抛错，退回空')

  const e3 = buildImageStrategy({
    mode: 'edit',
    referenceCount: 1,
    referenceVisual: visualJson,
    userPrompt: '把菜品换成我们店的鲜切黄牛肉'
  })
  ok(e3.visualLocked === true, '策略标记 visualLocked（回执据此说明「逐项锁定」）')
  ok(
    e3.prompt.includes('【保持】参考图的构图：居中对称') &&
      e3.prompt.includes('机位与视角：90 度俯拍') &&
      e3.prompt.includes('光线：自然侧逆光'),
    '「保持」逐项点名构图/机位/光线（不再是一句套话）'
  )
  ok(
    e3.prompt.includes('版式与留白：上方三分之一留白压标题') &&
      e3.prompt.includes('主体占比与位置：主体占画面 60%'),
    '留白与主体占比也进「保持」'
  )
  ok(e3.prompt.includes('画面元素（道具/桌面/背景，不含菜品）：白瓷碗/木桌/干冰雾气'), '道具沿用参考图（菜品仍以本店事实为准）')
  ok(e3.prompt.includes('只改内容，不要改版式'), '具体清单之后仍保留「不改版式」这条总纲')
  ok(
    e3.negative.includes('人均68') && e3.negative.includes('不要带出'),
    '参考图上的原文字被点名禁带出（只写「不要文字」时模型常照抄）'
  )
  ok(
    e3.notes.some((n) => n.includes('视觉拆解')) && e3.notes.some((n) => n.includes('保持')),
    '策略说明里写明「保持」来自视觉拆解（让策略看得见）'
  )
  const e4 = buildImageStrategy({ mode: 'edit', referenceCount: 1 })
  ok(e4.visualLocked === false, '没有视觉拆解 → 不谎报锁定')
  ok(
    e4.prompt.includes('构图与机位、镜头与光线、场景氛围') && e4.notes.some((n) => n.includes('通用口径')),
    '退回通用口径，并如实说明（旧卡/没拆过）'
  )
  ok(
    !buildImageStrategy({ mode: 'gen', referenceVisual: visualJson }).prompt.includes('【保持】'),
    '文生图不吃视觉拆解（没有参考图可保持）'
  )

  console.log('月度额度（唯一一道花钱的闸门，必须在发起请求前收敛）：')
  const q1 = buildImageStrategy({ count: 3, maxCount: 4, monthlyLimit: 100, usedThisMonth: 10 })
  ok(q1.count === 3 && q1.blocked === false && q1.remaining === 90, '有余额 → 按请求张数生成', 'count=' + q1.count + ' remaining=' + String(q1.remaining))
  const q2 = buildImageStrategy({ count: 4, maxCount: 4, monthlyLimit: 100, usedThisMonth: 98 })
  ok(q2.count === 2 && q2.remaining === 2, '余额不足 → 只生成剩余张数（绝不超额度）', 'count=' + q2.count)
  ok(q2.notes.some((n) => n.includes('剩余的 2 张')), '被额度压张数要说出来（不静默少给）')
  const q3 = buildImageStrategy({ count: 2, monthlyLimit: 100, usedThisMonth: 100 })
  ok(q3.blocked === true && q3.count === 0, '额度用尽 → 拦截且 count=0（调用方不得发起生成）', 'count=' + q3.count)
  ok(
    typeof q3.blockedReason === 'string' && q3.blockedReason.includes('每月张数上限'),
    '拦截原因要指出去哪里调额度',
    String(q3.blockedReason).slice(0, 40)
  )
  ok(q3.notes.some((n) => n.includes('已拦截')), '拦截要在策略说明里留痕')
  const q4 = buildImageStrategy({ count: 2, monthlyLimit: 0, usedThisMonth: 999 })
  ok(q4.blocked === false && q4.count === 2 && q4.remaining === null, '上限为 0 → 不限，不误拦')
  const q5 = buildImageStrategy({ count: 2, monthlyLimit: 100 })
  ok(q5.count === 2 && q5.remaining === 100, '未传已用张数 → 视为 0')
  const q6 = buildImageStrategy({ count: 4, maxCount: 4, monthlyLimit: 5, usedThisMonth: 3 })
  ok(q6.count === 2, '单次上限与月度额度同时生效时取更严的那个', 'count=' + q6.count)

  console.log('策略摘要（界面/日志/回执共用）：')
  const line = formatStrategy(s1)
  ok(
    line.includes('菜品特写') && line.includes('小红书') && line.includes('1024x1536'),
    '摘要含模板/平台/尺寸',
    line
  )
  ok(
    s1.notes.length >= 3 && s1.notes.every((n) => n.trim().length > 0),
    '策略说明非空（让「策略」在界面上看得见）'
  )
  ok(
    UNIVERSAL_NEGATIVE.includes('文字') && UNIVERSAL_NEGATIVE.includes('logo'),
    '通用负向词覆盖文字/水印/logo'
  )

  console.log('纯函数约束：')
  ok(typeof S.buildImageStrategy === 'function', '策略层可被独立打包断言（无 electron / DB 依赖）')
} finally {
  try {
    rmSync(work, { recursive: true, force: true })
  } catch {
    /* Windows 偶发占用 */
  }
}

console.log(failed === 0 ? '\n全部通过 ✅' : '\n' + failed + ' 项失败 ❌')
process.exit(failed === 0 ? 0 : 1)
