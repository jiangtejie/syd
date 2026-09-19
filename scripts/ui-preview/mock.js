/**
 * UI 预览桩：把真实渲染端放进浏览器里跑（只为看布局/交互，不连主进程、不碰真库）。
 * 由 make-preview.mjs 注入到 out/renderer/preview.html 的 <head>，先于业务 bundle 执行。
 */
(function () {
  var now = Date.now()
  var MIN = 60000, HOUR = 3600000, DAY = 86400000

  /* ── 1. 自定义协议图片 → 渐变 SVG（ct-growth:// / ct-media:// 在浏览器里加载不了）── */
  function hueOf(s) {
    var h = 0
    for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360
    return h
  }
  function mockImg(path) {
    var h = hueOf(String(path))
    var label = String(path).split('/').pop().slice(0, 14)
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640">' +
      '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="hsl(' + h + ',54%,64%)"/>' +
      '<stop offset="1" stop-color="hsl(' + (h + 40) % 360 + ',58%,36%)"/>' +
      '</linearGradient></defs>' +
      '<rect width="480" height="640" fill="url(#g)"/>' +
      '<text x="22" y="614" font-family="sans-serif" font-size="24" fill="rgba(255,255,255,.9)">' + label + '</text>' +
      '</svg>'
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg)
  }
  // ?noimg=1 关闭图片改写（排查排版问题时可对比）
  var NOIMG = /noimg/.test(location.search)
  var imgDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src')
  if (!NOIMG) Object.defineProperty(HTMLImageElement.prototype, 'src', {
    configurable: true,
    get: function () { return imgDesc.get.call(this) },
    set: function (v) {
      imgDesc.set.call(this, typeof v === 'string' && /^(ct-growth|ct-media):/.test(v) ? mockImg(v) : v)
    }
  })

  /* ── 2. 假数据 ── */
  var STORES = [
    { id: 1, name: '江眼镜·眼镜火锅', brandName: '江眼镜', city: '重庆', bizType: '火锅', enabled: true, profile: '{"signatureDishes":"鲜切黄牛肉、百香果牛肉","packages":"双人套餐128","bannedWords":"最、第一"}' }
  ]
  var TITLES = [
    '在重庆开了 12 年的社区火锅，人均 68 吃到扶墙',
    '火锅店老板不会告诉你的 5 个点单技巧',
    '这家藏在居民楼下的火锅，凌晨两点还在排队',
    '鲜切黄牛肉到底该怎么涮？8 秒出锅最嫩',
    '探店｜观音桥这家苍蝇馆子火锅，锅底香到隔壁',
    '打工人下班续命火锅，酸汤锅底一整个爱住',
    '带娃吃火锅不踩雷：这 4 样必点',
    '重庆火锅蘸料公式，香油蒜泥只是基础',
    '开了 20 年的老火锅，为什么能一直排队？',
    '火锅食材清单｜家庭版一次买齐不踩坑',
    '人均 50 的宝藏火锅，鸭肠脆到弹牙',
    '火锅店选址的秘密：为什么都开在二楼'
  ]
  var CONTENTS = TITLES.map(function (t, i) {
    return {
      id: i + 1,
      kind: i % 4 === 3 ? 'video' : 'image_text',
      origin: i % 3 === 0 ? 'douyin' : 'xhs',
      platformItemId: 'p' + i,
      storeId: 1,
      title: t,
      text: '正文示例：' + t + '。这里是一段用于评估排版密度的正文，包含标签与换行。',
      authorName: ['火锅研究所', '重庆吃货日记', '探店小分队', '美食猎人'][i % 4],
      authorId: 'u' + i,
      link: 'https://example.com/p/' + i,
      publishedAt: now - (i + 1) * DAY,
      tags: i % 3 === 0 ? ['舆情'] : [],
      usage: i % 5 === 0 ? 'own' : 'ref',
      interactions: { likes: 1200 + i * 337, collects: 210 + i * 41, comments: 33 + i * 7, shares: 12 + i },
      extra: {},
      score: 98 - i * 7,
      status: ['new', 'ready', 'used', 'archived'][i % 4],
      note: i === 1 ? '这家摆盘值得学' : '',
      createdAt: now - (i + 1) * DAY,
      updatedAt: now - i * HOUR,
      coverRelPath: 'demo/cover-' + i + '.jpg',
      thumbRelPath: 'demo/thumb-' + i + '.jpg',
      assetCount: 3 + (i % 4)
    }
  })
  var DETAIL = Object.assign({}, CONTENTS[0], {
    assets: [0, 1, 2, 3].map(function (k) {
      return {
        id: 100 + k, contentId: 1, kind: k === 0 ? 'cover' : 'image', sha256: 'sha' + k,
        mime: 'image/jpeg', size: 240000, width: 1080, height: 1440, durationMs: 0,
        relPath: 'demo/pic-' + k + '.jpg', thumbRelPath: 'demo/thumb-' + k + '.jpg',
        sourceMark: 'ref:xhs', createdAt: now - DAY
      }
    }),
    decomp: {
      contentId: 1, modelVer: 'analyze-v2',
      structure: {
        hook: '用「开了 12 年」建立信任，再用「人均 68」打破贵价预期',
        structure: '痛点（怕贵怕踩雷）→ 方案（点名 3 道必点）→ 证据（排队照/实拍）→ 促单（人均+地址）',
        sellingPoints: ['鲜切黄牛肉', '人均 68', '凌晨两点还在营业'],
        titlePatterns: ['数字年限 + 人均价格 + 结果承诺'],
        commentTopics: ['停车方不方便', '能不能订位', '有没有鸳鸯锅'],
        whyWorks: '把「老店」的确定性翻译成「不会踩雷」，配上低价锚点，降低决策成本。'
      },
      visual: {
        composition: '居中对称，主体略偏下', camera: '90 度俯拍', lighting: '自然侧逆光',
        colorTone: '暖橙高饱和', layout: '上方三分之一留白压标题', subjectRatio: '主体占画面 60%',
        elements: ['白瓷碗', '木桌', '干冰雾气'], textInImage: '人均68'
      },
      commentTopics: ['停车方不方便', '能不能订位', '有没有鸳鸯锅'],
      createdAt: now - 2 * DAY
    },
    remixOutputs: [
      { id: 11, contentId: 1, variant: 'titles', title: '开了 12 年的社区火锅，人均 68 吃到扶墙\n本地人排队到凌晨的火锅，到底值不值\n人均 68 的宝藏火锅，鲜切黄牛肉管够', copy: '', complianceHints: [], status: 'adopted', createdAt: now - HOUR },
      { id: 12, contentId: 1, variant: 'copy', title: '', copy: '在观音桥开了 12 年，锅底用的是牛油老料，鲜切黄牛肉八秒出锅。人均 68，两个人点四个菜就够。', complianceHints: ['「最」属于绝对化用语'], status: 'draft', createdAt: now - HOUR }
    ]
  })

  var SESSIONS = [
    { username: '1111@chatroom', displayName: '重庆观音桥门店群', isGroup: true, unreadCount: 3, lastTimestamp: now - 6 * MIN, lastMessage: '今天的鸭肠到货了吗', memberCount: 42, pinned: false, muted: false, tag: '' },
    { username: 'wxid_huangqiao', displayName: '黄巧（物配客服）', isGroup: false, unreadCount: 1, lastTimestamp: now - 22 * MIN, lastMessage: '对账单发你了', memberCount: 0, pinned: true, muted: false, tag: '' },
    { username: '2222@chatroom', displayName: '物配供应商群', isGroup: true, unreadCount: 0, lastTimestamp: now - 2 * HOUR, lastMessage: '明天排车 6 点', memberCount: 88, pinned: false, muted: false, tag: '' },
    { username: 'wxid_chenxi', displayName: '陈西西', isGroup: false, unreadCount: 0, lastTimestamp: now - 5 * HOUR, lastMessage: '好的谢谢', memberCount: 0, pinned: false, muted: false, tag: '' },
    { username: '3333@chatroom', displayName: '成都成华店群', isGroup: true, unreadCount: 0, lastTimestamp: now - DAY, lastMessage: '收到', memberCount: 31, pinned: false, muted: false, tag: '' },
    { username: 'wxid_laoban', displayName: '江老板', isGroup: false, unreadCount: 0, lastTimestamp: now - 2 * DAY, lastMessage: '这周复盘一下', memberCount: 0, pinned: false, muted: false, tag: '' }
  ]
  var MESSAGES = [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) {
    return {
      id: 1000 + i, sessionId: '1111@chatroom', serverId: 's' + i, sortSeq: i,
      timestamp: now - (8 - i) * 7 * MIN, isSend: i % 3 === 2, senderName: i % 3 === 2 ? '我' : '黄巧',
      senderUsername: i % 3 === 2 ? 'me' : 'wxid_huangqiao', type: 1, localType: 1,
      content: ['今天的鸭肠到货了吗', '到了，早上 9 点到的', '[图片]', '总价多少', '电子单开给我哈', '好，下午发你', '收到', '谢谢'][i],
      parsedContent: '', isTeam: false, quote: null
    }
  })
  var TASKS = [
    { id: 1, contentId: 1, contentTitle: CONTENTS[0].title, contentKind: 'image_text', contentOrigin: 'xhs', storeId: 1, storeName: '江眼镜·眼镜火锅', title: CONTENTS[0].title.slice(0, 12) + '…', running: true, goal: 'image_text', status: 'drafting', sessionId: 1, summary: '已采用 2 条标题，正在生成封面', updatedAt: now - 3 * MIN, lastMessageAt: now - 3 * MIN, pendingCandidates: 2, contentCover: 'demo/cover-0.jpg', outputImages: ['demo/out-1.jpg', 'demo/out-2.jpg'] },
    { id: 2, contentId: 2, contentTitle: CONTENTS[1].title, contentKind: 'image_text', contentOrigin: 'douyin', storeId: 1, storeName: '江眼镜·眼镜火锅', title: '点单技巧…', running: false, goal: 'image_text', status: 'drafting', sessionId: 2, summary: '待开始', updatedAt: now - 2 * HOUR, lastMessageAt: now - 2 * HOUR, pendingCandidates: 0, contentCover: 'demo/cover-1.jpg', outputImages: [] },
    { id: 3, contentId: 3, contentTitle: CONTENTS[2].title, contentKind: 'video', contentOrigin: 'xhs', storeId: 1, storeName: '江眼镜·眼镜火锅', title: '凌晨两点排队…', running: false, goal: 'video', status: 'done', sessionId: 3, summary: '脚本已定稿', updatedAt: now - DAY, lastMessageAt: now - DAY, pendingCandidates: 0, contentCover: 'demo/cover-2.jpg', outputImages: ['demo/out-3.jpg'] }
  ]
  var CHAT = [
    { id: 1, role: 'assistant', kind: 'text', content: '已把这条素材放进工作台，拆解卡与门店事实已加载。\n\n可以直接告诉我改什么，例如：换 5 个标题突出人均；正文改成探店风 120 字。', createdAt: now - 20 * MIN },
    { id: 2, role: 'user', kind: 'text', content: '换 5 个标题，突出「人均 68」和「鲜切黄牛肉」', createdAt: now - 18 * MIN },
    { id: 3, role: 'assistant', kind: 'tool_call', content: '改写标题', meta: { name: 'growth_rewrite_title', status: 'done', args: '{"count":5,"style":"tanDian"}', output: '已生成 5 条候选标题' }, createdAt: now - 17 * MIN },
    { id: 4, role: 'assistant', kind: 'tool_call', content: '读取素材', meta: { name: 'growth_read_material', status: 'done', args: '{}', output: '标题/正文/互动/拆解卡' }, createdAt: now - 17 * MIN },
    { id: 5, role: 'assistant', kind: 'tool_call', content: '生成配图', meta: { name: 'growth_gen_image', status: 'start', args: '{"role":"cover","platform":"xhs"}', output: '' }, createdAt: now - 4 * MIN },
    { id: 6, role: 'assistant', kind: 'text', content: '已生成 2 张竖版封面候选（右侧可点选）：一张俯拍红油锅底，一张鲜切牛肉特写。要哪张我就采用并合成封面标题。', createdAt: now - 3 * MIN }
  ]
  var OUTPUTS = [
    { id: 21, taskId: 1, variant: 'titles', title: '开了 12 年的社区火锅，人均 68 吃到扶墙\n本地人排队到凌晨的火锅，到底值不值\n人均 68 的宝藏火锅，鲜切黄牛肉管够', copy: '', complianceHints: [], status: 'adopted', createdAt: now - 12 * MIN, assets: [], meta: {} },
    { id: 22, taskId: 1, variant: 'chat:image', title: '', copy: '', complianceHints: ['「最」属于绝对化用语'], status: 'adopted', createdAt: now - 3 * MIN, assets: [ { id: 31, assetId: 501, role: 'cover', source: 'gen', prompt: '俯拍红油锅底', note: '模板：封面氛围 · 小红书 2:3', relPath: 'demo/gen-1.jpg' }, { id: 32, assetId: 502, role: 'image', source: 'gen', prompt: '鲜切牛肉特写', note: '模板：菜品特写', relPath: 'demo/gen-2.jpg' } ], meta: { strategy: { notes: ['模式：图生图（图1 结构模板，保持构图，替换为本店信息）', '视觉拆解：居中对称；90 度俯拍；自然侧逆光（据此锁定「保持」清单）'] } } }
  ]
  var CANDIDATES = [
    { id: 41, taskId: 1, variant: 'titles', title: '这家火锅人均 68，鲜切牛肉管够\n12 年老店，本地人排到凌晨\n观音桥宝藏火锅，值得专程来一趟', copy: '', complianceHints: [], status: 'pending', createdAt: now - 5 * MIN, assets: [], meta: {} }
  ]
  var BUZZ_MENTIONS = [0, 1, 2, 3, 4, 5].map(function (i) {
    return {
      id: i + 1, storeId: 1, storeName: '江眼镜·眼镜火锅', platform: i % 2 ? 'xhs' : 'douyin', kind: 'image_text',
      url: 'https://example.com/buzz/' + i, platformItemId: 'b' + i,
      title: ['江眼镜火锅好吃吗？排队 1 小时值不值', '避雷！这家火锅服务态度差', '江眼镜新品酸汤锅底测评', '在江眼镜吃到头发，店家态度还行', '重庆火锅推荐：江眼镜排第几', '江眼镜火锅的鸭肠绝了'][i],
      contentText: '正文示例：这是一条用于评估舆情卡片密度的正文，包含若干描述与情绪表达。',
      authorName: ['火锅研究所', '本地吃货', '匿名用户'][i % 3], authorId: 'bu' + i,
      publishedAt: now - (i + 1) * DAY, interactions: { likes: 320 - i * 40, collects: 40 + i, comments: 18 + i, shares: 3 + i },
      assets: ['demo/buzz-' + i + '.jpg'], source: 'link',
      status: ['new', 'reviewing', 'replied', 'ignored'][i % 4],
      sentiment: ['positive', 'negative', 'neutral', 'negative', 'positive', 'positive'][i],
      score: [62, -71, 8, -42, 35, 78][i],
      riskLevel: i === 1 || i === 3 ? 'medium' : 'low',
      reasons: [{ tag: '服务态度', weight: 3, evidence: '态度差' }], diagnosis: {},
      diagnosedAt: i % 2 ? now - HOUR : null, note: '', createdAt: now - (i + 1) * DAY, updatedAt: now - i * HOUR,
      commentCount: 5 + i, highCommentCount: i % 3
    }
  })

  /* ── 3. 覆盖表（其余一律 safeStub：调用返回 {ok:true}，on* 返回取消函数）── */
  var overrides = {
    'wx.getSessions': function () { return Promise.resolve({ ok: true, sessions: SESSIONS }) },
    'wx.getMessages': function () { return Promise.resolve({ ok: true, messages: MESSAGES }) },
    'wx.getMessagesSince': function () { return Promise.resolve({ ok: true, messages: [] }) },
    'wx.dbChanged': function () { return Promise.resolve({ ok: true }) },
    // onboarding.done=1：别让首启向导挡住评审
    'config.getAll': function () { return Promise.resolve({ 'onboarding.done': '1', 'export.folder': 'D:\\\\导出\\\\私域运营' }) },
    'growth.stats': function () { return Promise.resolve({ ok: true, stats: { contentCount: 128, assetCount: 342 } }) },
    'growth.listContent': function () { return Promise.resolve({ ok: true, items: CONTENTS, total: CONTENTS.length }) },
    'growth.getContent': function () { return Promise.resolve({ ok: true, item: DETAIL }) },
    'growth.overview': function () { return Promise.resolve({ ok: true, overview: { contentCount: 128, decompCount: 96, remixOutputCount: 213 } }) },
    'growthai.listStores': function () { return Promise.resolve({ ok: true, stores: STORES }) },
    'growthai.listTasks': function () { return Promise.resolve({ ok: true, tasks: TASKS }) },
    'growthai.getTask': function (id) {
      var t = TASKS.filter(function (x) { return x.id === id })[0] || TASKS[0]
      return Promise.resolve({ ok: true, task: t, outputs: OUTPUTS, candidates: CANDIDATES })
    },
    'growthai.messages': function () { return Promise.resolve({ ok: true, messages: CHAT }) },
    'growthai.running': function () { return Promise.resolve({ ok: true, running: true }) },
    'growthbuzz.overview': function () {
      return Promise.resolve({ ok: true, overview: { total: 42, positive: 21, neutral: 9, negative: 12, pending: 7, highRisk: 3, avgScore: 12.4, recent: BUZZ_MENTIONS.slice(0, 4).map(function (m) { return { id: m.id, title: m.title, sentiment: m.sentiment, score: m.score, platform: m.platform, createdAt: m.createdAt } }) } })
    },
    'growthbuzz.list': function () { return Promise.resolve({ ok: true, items: BUZZ_MENTIONS, total: BUZZ_MENTIONS.length }) },
    'growthbuzz.detail': function (id) {
      var m = BUZZ_MENTIONS.filter(function (x) { return x.id === id })[0] || BUZZ_MENTIONS[0]
      return Promise.resolve({ ok: true, mention: m, comments: [ { id: 1, mentionId: m.id, authorName: '小张', content: '上周去吃了，鸭肠确实不错', likes: 12, isHigh: true, source: 'manual', publishedAt: null, createdAt: now - HOUR } ], diagnosis: null })
    },
    'export.chat': function () { return Promise.resolve({ ok: true, files: 128 }) },
    'export.business': function () { return Promise.resolve({ ok: true, files: 12 }) },
    'app.version': function () { return Promise.resolve('1.0.0') },
    // keyStore.list 返回数组（不是 {ok}）—— 设置页会对它调 .some()，给错形状会直接崩到错误边界
    'keyStore.list': function () { return Promise.resolve([]) }
  }

  function mk(path) {
    var call = function () { return Promise.resolve({ ok: true }) }
    return new Proxy(call, {
      get: function (_t, k) {
        if (k === 'then' || k === 'catch' || k === 'finally') return undefined
        if (typeof k === 'symbol') return undefined
        var name = String(k)
        // onXxx(cb) → 返回取消订阅函数（事件订阅的调用方会去调它）
        if (/^on[A-Z]/.test(name)) return function () { return function () {} }
        var p = path ? path + '.' + name : name
        if (Object.prototype.hasOwnProperty.call(overrides, p)) return overrides[p]
        return mk(p)
      },
      apply: function () { return Promise.resolve({ ok: true }) }
    })
  }

  // 收集 console.error / window.onerror，便于定位预览里的运行时问题
  window.__errors = []
  var ce = console.error
  console.error = function () {
    try { window.__errors.push([].slice.call(arguments).map(String).join(' ')) } catch (e) { /* ignore */ }
    ce.apply(console, arguments)
  }
  window.addEventListener('error', function (e) {
    window.__errors.push('onerror: ' + (e.message || '') + '\n' + ((e.error && e.error.stack) || ''))
  })

  window.api = { cs: mk('') }
  window.__UI_PREVIEW__ = true
})()
