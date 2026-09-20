/**
 * UI 预览桩：把真实渲染端放进浏览器里跑（只为看布局/交互，不连主进程、不碰真库）。
 * 由 make-preview.mjs 注入到 out/renderer/preview.html 的 <head>，先于业务 bundle 执行。
 */
(function () {
  var now = Date.now()
  var MIN = 60000, HOUR = 3600000, DAY = 86400000

  /* ── 1. 自定义协议图片 → 渐变 SVG（ct-media:// 在浏览器里加载不了）── */
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
      imgDesc.set.call(this, typeof v === 'string' && /^ct-media:/.test(v) ? mockImg(v) : v)
    }
  })

  /* ── 2. 假数据 ── */
  // 会话列表：给足行数（客户页直接由这份数据派生），才能看出列表密度与是否要分页
  var NAME_POOL = [
    ['重庆观音桥门店群', true, 42], ['黄巧（物配客服）', false, 0], ['物配供应商群', true, 88],
    ['陈西西', false, 0], ['成都成华店群', true, 31], ['江老板', false, 0],
    ['小龙坎旗舰店群', true, 126], ['李雪（前厅主管）', false, 0], ['火锅底料直采群', true, 54],
    ['王强', false, 0], ['重庆大学城门店群', true, 27], ['周敏（财务）', false, 0],
    ['美团运营对接群', true, 16], ['赵磊', false, 0], ['贵阳观山湖店群', true, 24],
    ['孙倩', false, 0], ['餐具耗材采购群', true, 63], ['吴桐（加盟商）', false, 0],
    ['昆明南亚店群', true, 38], ['郑好', false, 0], ['设备维修群', true, 9],
    ['冯磊（店长）', false, 0], ['长沙解放西店群', true, 45], ['蒋文静', false, 0]
  ]
  var LAST_MSG = [
    '今天的鸭肠到货了吗', '对账单发你了', '明天排车 6 点', '好的谢谢', '收到', '这周复盘一下',
    '周末的团购券核销了 18 张', '排班表我改好了', '这批底料辣度是不是调了', '在吗',
    '店里空调坏了有人来看吗', '发票开好了发你', '下个月的投放预算定了吗', '晚点回你',
    '门口修路客流掉了一半', '好的我转给采购', '牛油到货时间能提前吗', '加盟合同我看了',
    '新菜单图片麻烦重拍', '收到，谢谢', '洗碗机又漏水了', '明天早会我请假',
    '晚上的包间订满了', '辛苦了'
  ]
  var SESSIONS = NAME_POOL.map(function (p, i) {
    return {
      // 首个群沿用 1111@chatroom —— MESSAGES 的 sessionId 指向它，改了就看不到气泡
      username: i === 0 ? '1111@chatroom' : p[1] ? 1000 + i + '@chatroom' : 'wxid_' + i,
      displayName: p[0], isGroup: p[1],
      unreadCount: [3, 1, 0, 0, 0, 0, 12, 2, 0, 0, 0, 1, 0, 0, 7, 0, 0, 0, 4, 0, 0, 0, 0, 0][i],
      lastTimestamp: now - (i + 1) * 41 * MIN,
      lastMessage: LAST_MSG[i], memberCount: p[2],
      pinned: i === 1, muted: i % 7 === 3, tag: ''
    }
  })
  var MESSAGES = [0, 1, 2, 3, 4, 5, 6, 7].map(function (i) {
    return {
      id: 1000 + i, sessionId: '1111@chatroom', serverId: 's' + i, sortSeq: i,
      timestamp: now - (8 - i) * 7 * MIN, isSend: i % 3 === 2, senderName: i % 3 === 2 ? '我' : '黄巧',
      senderUsername: i % 3 === 2 ? 'me' : 'wxid_huangqiao', type: 1, localType: 1,
      content: ['今天的鸭肠到货了吗', '到了，早上 9 点到的', '总价多少', '按老价格算，鸭肠 22 一斤', '电子单开给我哈', '好，下午发你', '收到', '谢谢'][i],
      // 气泡文字取自 parsedContent（不是 content）——给空串会整列显示「[消息]」占位
      parsedContent: ['今天的鸭肠到货了吗', '到了，早上 9 点到的', '总价多少', '按老价格算，鸭肠 22 一斤', '电子单开给我哈', '好，下午发你', '收到', '谢谢'][i],
      isTeam: false, quote: null
    }
  })

  // 群问题（右栏「群问题」视图）：形状必须齐 —— 面板按 status/severity/needConfirm/reopenCount 分支渲染
  var GIP_ISSUES = [
    { id: 1, key: 'k1', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '物流', title: '鸭肠今天没到货，中午高峰期断了三份单', summary: '客户 10:12 问鸭肠到货，11:40 又催了一次，至今无人回复。', occurAt: now - 5 * HOUR, status: 'open', method: 'llm', assignee: 'wxid_huangqiao', followUp: true, followUpAt: now - 14 * HOUR, followUpOverdue: true, severity: '紧急', customers: ['黄巧'], createdAt: now - 5 * HOUR, updatedAt: now - 40 * MIN, msgCount: 6 },
    { id: 2, key: 'k2', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '客诉', title: '客人反映锅底有头发，要求免单', summary: '客人当场拍照并要求免单，店里先送了果盘安抚。', occurAt: now - DAY, status: 'open', method: 'llm', severity: '高', reopenCount: 2, reopenedFrom: 9, lastReplyBy: 'wxid_lixue', customers: ['李雪'], createdAt: now - DAY, updatedAt: now - 3 * HOUR, msgCount: 11 },
    { id: 3, key: 'k3', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '价格', title: '牛油底料这批涨价 8%，要不要换供应商', summary: '', occurAt: now - 2 * DAY, status: 'open', method: 'rule', needConfirm: true, severity: '一般', customers: [], createdAt: now - 2 * DAY, updatedAt: now - 2 * DAY, msgCount: 3 },
    { id: 4, key: 'k4', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '售后', title: '洗碗机漏水，维修师傅约到周四', summary: '已联系售后，周四上门。', occurAt: now - 3 * DAY, status: 'done', method: 'llm', assignee: 'wxid_huangqiao', autoDone: true, resolvedAt: now - 2 * DAY, severity: '一般', createdAt: now - 3 * DAY, updatedAt: now - 2 * DAY, msgCount: 8 },
    { id: 5, key: 'k5', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '咨询', title: '新菜单图片要不要重拍', summary: '', occurAt: now - 4 * DAY, status: 'stalled', method: 'rule', severity: '一般', createdAt: now - 4 * DAY, updatedAt: now - 3 * DAY, msgCount: 2 },
    { id: 6, key: 'k6', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '其他', title: '群里转发的团购券截图', summary: '', occurAt: now - 6 * DAY, status: 'archived', method: 'rule', archivedFrom: 'open', severity: '一般', createdAt: now - 6 * DAY, updatedAt: now - 6 * DAY, msgCount: 1 },
    { id: 7, key: 'k7', wxid: 'wxid_jiangyanjing', groupUsername: '1111@chatroom', groupName: '重庆观音桥门店群', type: '建议', title: '门口修路，建议加做外卖满减', summary: '店长提议把堂食客流缺口用外卖补回来。', occurAt: now - 20 * HOUR, status: 'open', method: 'llm', severity: '一般', customers: ['冯磊'], createdAt: now - 20 * HOUR, updatedAt: now - 20 * HOUR, msgCount: 4 }
  ]
  var GIP_DETAIL = function (id) {
    var base = GIP_ISSUES.filter(function (x) { return x.id === id })[0] || GIP_ISSUES[0]
    return Object.assign({}, base, {
      related: [
        { time: base.occurAt, senderName: '黄巧', senderUsername: 'wxid_huangqiao', isSend: false, text: '今天的鸭肠到货了吗？中午要用', localType: 1 },
        { time: base.occurAt + 40 * MIN, senderName: '我', isSend: true, senderIsTeam: true, text: '我问一下物配那边', localType: 1 },
        { time: base.occurAt + 88 * MIN, senderName: '黄巧', senderUsername: 'wxid_huangqiao', isSend: false, text: '客人都催了两轮了，实在不行我先去菜市场补一点', localType: 1 }
      ]
    })
  }

  /* ── 3. 覆盖表（其余一律 safeStub：调用返回 {ok:true}，on* 返回取消函数）── */
  var overrides = {
    'wx.getSessions': function () { return Promise.resolve({ ok: true, sessions: SESSIONS }) },
    'wx.getMessages': function () { return Promise.resolve({ ok: true, messages: MESSAGES }) },
    'wx.getMessagesSince': function () { return Promise.resolve({ ok: true, messages: [] }) },
    'wx.dbChanged': function () { return Promise.resolve({ ok: true }) },
    // 团队成员：群问题面板的「跟进人」靠它把 username 换成中文名。
    // 不给的话面板上会直接显示 wxid_huangqiao —— 那是桩数据的假象，不是真排版。
    // 回复建议：给三条长短不一的候选，才能看出卡片在窄栏里的排版
    'ai.generateReply': function () {
      return Promise.resolve({
        ok: true,
        candidates: [
          { text: '好的，我这边先跟物配确认到货时间，十分钟内回你。' },
          { text: '鸭肠今天上午 9 点已经到库了。我先让后厨给你这边留 5 斤应急，剩下的下午 3 点前补齐，到时候我拍照给你确认。' },
          { text: '抱歉让你久等了！' }
        ]
      })
    },
    'team.list': function () {
      return Promise.resolve({
        ok: true,
        members: [
          { username: 'wxid_huangqiao', label: '黄巧', addedAt: now - 30 * DAY },
          { username: 'wxid_lixue', label: '李雪', addedAt: now - 20 * DAY },
          { username: 'wxid_fenglei', label: '冯磊', addedAt: now - 10 * DAY }
        ]
      })
    },
    // onboarding.done=1：别让首启向导挡住评审
    'config.getAll': function () { return Promise.resolve({ 'onboarding.done': '1', 'export.folder': 'D:\\\\导出\\\\私域运营' }) },
    // ffmpeg 现状：形状必须齐 —— 设置页按 source 分支说「无需配置」还是「正在回退」，
    // 少字段会渲染成「正在读取 ffmpeg 状态…」，看不出这行到底对不对
    'media.ffmpegStatus': function () {
      return Promise.resolve({
        ok: true,
        status: {
          path: 'C:/Program Files/私域运营助手/resources/bin/ffmpeg.exe',
          source: 'bundled',
          bundled: {
            path: 'C:/Program Files/私域运营助手/resources/bin/ffmpeg.exe',
            exists: true,
            sizeMb: 211.9,
            version: '9.0.1-full_build-www.gyan.dev'
          },
          configured: '',
          configuredExists: false,
          envPath: '',
          envExists: false
        }
      })
    },
    'export.chat': function () { return Promise.resolve({ ok: true, files: 128 }) },
    'export.business': function () { return Promise.resolve({ ok: true, files: 12 }) },
    'app.version': function () { return Promise.resolve('1.0.0') },
    // keyStore.list 返回数组（不是 {ok}）—— 设置页会对它调 .some()，给错形状会直接崩到错误边界
    'keyStore.list': function () { return Promise.resolve([]) },
    // 议题/看板：**形状必须给全**。给 {ok:true} 会让监控页在空数据上反复重算，主线程像卡死一样
    // （实测：整页 Runtime.evaluate 超时，只能关掉标签页重来）。
    'issue.list': function () {
      return Promise.resolve({ ok: true, issues: GIP_ISSUES, total: GIP_ISSUES.length })
    },
    // 对话页右栏「群问题」视图
    'issue.listGroup': function () {
      return Promise.resolve({ ok: true, issues: GIP_ISSUES, excluded: false })
    },
    'issue.detail': function (id) { return Promise.resolve({ ok: true, issue: GIP_DETAIL(id) }) },
    'issue.analyzeGroup': function () {
      // coverage 的真实契约是 { msgs, truncated }（见 src/shared/api.ts analyzeGroup）；
      // 这里原来写成 { from, to, messages, issues }，渲染端取 coverage.msgs 就成了 undefined
      return Promise.resolve({
        ok: true,
        skipped: true,
        method: 'llm',
        lastAt: now - 42 * MIN,
        coverage: { msgs: 428, truncated: false }
      })
    },
    'issue.groupSenders': function () { return Promise.resolve({ ok: true, senders: [] }) },
    'issue.groupBadges': function () { return Promise.resolve({ ok: true, badges: { '1111@chatroom': 4 } }) },
    'issue.overview': function () {
      return Promise.resolve({
        ok: true,
        metrics: {
          kpis: {
            pending: 0,
            following: 0,
            followOverdue: 0,
            backlog48: 0,
            createdToday: 0,
            resolvedToday: 0,
            closedRate: null,
            archivedClosed: 0
          },
          trend: [],
          typeOpen: [],
          groupTop: [],
          age: []
        }
      })
    },
    'issue.state': function () { return Promise.resolve({ ok: true, state: null }) },
    'reply.getSendStatus': function () {
      return Promise.resolve({
        enabled: true,
        halted: false,
        todayCount: 42,
        dailyLimit: 200,
        lastFailures: []
      })
    },
    'reply.stats7d': function () {
      return Promise.resolve(
        Array.from({ length: 7 }, function (_, i) {
          return { day: '2026-09-' + String(11 + i), sent: 20 + i * 3, failed: i % 3 }
        })
      )
    },
    // SendOverview：days / totals / verifiedRate / failReasons —— 形状给错看板会崩在 .length
    'reply.overview': function () {
      return Promise.resolve({
        ok: true,
        data: {
          days: 7,
          totals: { sent: 271, failed: 15, blocked: 3 },
          verifiedRate: 0.93,
          failReasons: [
            { reason: '对端已删除', count: 8 },
            { reason: '发送超时', count: 4 },
            { reason: '被风控拦截', count: 3 }
          ]
        }
      })
    },
    // 消息级运营统计（看板下半屏）
    'reply.opsStats': function () {
      return Promise.resolve({
        ok: true,
        data: {
          days: 7,
          series: Array.from({ length: 7 }, function (_, i) {
            return { day: '9/' + String(11 + i), inbound: 60 + i * 8, outbound: 42 + i * 5 }
          }),
          byHour: Array.from({ length: 24 }, function (_, h) {
            return { hour: h, count: h >= 9 && h <= 21 ? 30 + ((h * 7) % 25) : 2 }
          }),
          byType: [
            { type: '群聊', count: 320 },
            { type: '单聊', count: 180 },
            { type: '公众号', count: 12 }
          ],
          activeSessions: 38,
          newSessions: 6
        }
      })
    }
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
