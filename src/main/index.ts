import {
  app,
  shell,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  Notification,
  nativeImage,
  dialog,
  protocol,
  net
} from 'electron'
import { join, resolve, sep } from 'path'
import { pathToFileURL } from 'url'
import { Readable } from 'stream'
import { createReadStream, existsSync, statSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDb, closeDb, getLastMigrateResult } from './db/database'
import { getMediaRootDir, migrateLegacyCacheLayout } from './services/paths'
import { mimeForMediaFile, parseMediaPath, parseRangeHeader } from './services/media/mediaProtocol'
import { migrateStoredSecretPrefixes, migrateStoredSecrets } from './services/secrets'
import {
  clearInjectShots,
  startInjectShotsHousekeeping,
  stopInjectShotsHousekeeping
} from './services/wechat/injectShots'
import { clearPlainDbCache } from './services/wechat/decrypt'
import { listTables } from './db/schema'
import {
  reconcileInterruptedTasks,
  startDbHousekeeping,
  stopDbHousekeeping
} from './db/housekeeping'
import { consumeCrashMarker, installCrashGuard } from './services/crashGuard'
import { stopBaseSyncScheduler } from './services/lark/baseSyncScheduler'
import { getConfigBoolean } from './db/repos/config'
import { APP_NAME } from '../shared/appInfo'
import { registerKeyStoreHandlers } from './ipc/keyStoreHandlers'
import { registerWechatHandlers } from './ipc/wechatHandlers'
import { registerAiHandlers } from './ipc/aiHandlers'
import { registerSendHandlers } from './ipc/sendHandlers'
import { registerConfigHandlers } from './ipc/configHandlers'
import { registerDialogHandlers } from './ipc/dialogHandlers'
import { registerAppHandlers } from './ipc/appHandlers'
import { registerMediaHandlers } from './ipc/mediaHandlers'
import { registerCryptoHandlers } from './ipc/cryptoHandlers'
import { registerIssueHandlers } from './ipc/issueHandlers'
import { registerAgentHandlers } from './ipc/agentHandlers'
import { registerDutyHandlers } from './ipc/dutyHandlers'
import { registerTeamHandlers } from './ipc/teamHandlers'
import { registerCustomerHandlers } from './ipc/customerHandlers'
import { registerImHandlers, bootImAccounts, stopAllIm } from './ipc/imHandlers'
import { registerExportHandlers } from './ipc/exportHandlers'
import { registerWorkbenchHandlers } from './ipc/workbenchHandlers'
import { registerLogHandlers } from './ipc/logsHandlers'
import { registerChannelFileHandlers } from './ipc/channelFileHandlers'
import { registerReportHandlers } from './ipc/reportHandlers'
import { registerLarkHandlers } from './ipc/larkHandlers'
import { migrateLegacyImAudit } from './db/repos/imAuditRepo'
import { registerFeishuNotifyHandlers } from './ipc/feishuNotifyHandlers'
import { startReportScheduler, stopReportScheduler } from './services/report/scheduler'
import { createLogger } from './services/logging'
import { startFileHousekeeping, stopFileHousekeeping } from './services/im/channelFiles'
import { startMediaHousekeeping, stopMediaHousekeeping } from './services/media/mediaCache'
import { migrateArchiveLayout } from './services/report/mediaArchive'

const appLog = createLogger('app')
import { stopAllWatches, setOnDbChangedNotify } from './services/wechat/watchService'
import { stopAll as stopIssueScheduler } from './services/feedback/scheduler'
import { stopSending } from './services/send/sendService'

/**
 * 主进程入口。
 * 桌面体验设计（参考 CipherTalk windowManager 模式，自研实现）：
 * - 单实例锁：二次启动聚焦已有窗口
 * - titleBarStyle hidden + overlay：原生窗控按钮融合自定义标题栏
 * - 关闭最小化到托盘：客服工作台常驻后台
 * - 新消息：窗口未聚焦时 flashFrame + 系统通知（聚焦时抑制），点击通知聚焦
 */

let mainWindow: BrowserWindow | null = null
let tray: Tray | null = null
let isQuitting = false
let lastNotifyAt = 0
// 产品名见 shared/appInfo.ts（改名只需改那一处）

function focusMainWindow(): void {
  if (!mainWindow) return
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

function createTray(): void {
  if (tray) return
  // 托盘图标：Windows 推荐 16x16，过大时缩放
  const img = nativeImage.createFromPath(icon)
  tray = new Tray(img.resize({ width: 16, height: 16 }))
  tray.setToolTip(APP_NAME)
  const menu = Menu.buildFromTemplate([
    { label: '显示主窗口', click: focusMainWindow },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        isQuitting = true
        app.quit()
      }
    }
  ])
  tray.setContextMenu(menu)
  tray.on('click', focusMainWindow)
}

/**
 * 把一个已校验过的本地媒体文件回给渲染层，并支持 HTTP Range。
 *
 * 为什么必须支持 Range：<audio>/<video> 只有在响应能 206 + Accept-Ranges 时才把资源当
 * 「可寻址」处理。此前一律 net.fetch(file://)，Chromium 只能当一次性流，语音气泡上
 * 进度条拖不动、时长也可能读不出来。图片走同样的路径（多了 Accept-Ranges 无副作用）。
 */
async function serveMediaFile(file: string, rangeHeader: string | null): Promise<Response> {
  let size = 0
  try {
    size = statSync(file).size
  } catch {
    return new Response('Not found', { status: 404 })
  }
  const range = parseRangeHeader(rangeHeader, size)
  if (range === 'invalid') {
    return new Response('Range Not Satisfiable', {
      status: 416,
      headers: { 'Content-Range': `bytes */${size}` }
    })
  }
  if (!range) {
    const res = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(res.headers)
    headers.set('Accept-Ranges', 'bytes')
    return new Response(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers
    })
  }
  const body = Readable.toWeb(
    createReadStream(file, { start: range.start, end: range.end })
  ) as unknown as ReadableStream
  return new Response(body, {
    status: 206,
    headers: {
      'Content-Type': mimeForMediaFile(file),
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${size}`,
      'Accept-Ranges': 'bytes'
    }
  })
}

/**
 * 自定义 media 协议：把缓存目录的已解密媒体以 ct-media://media/<wxid>/<文件名> 暴露给渲染层。
 * dev 渲染源是 http://localhost，file:// 子资源会被 Chromium 拦截，故统一走协议。
 * 语音走三段布局 `/voices/<id>.wav`（SILK 解码产物，命名规则与图片不同）。
 * 安全：文件名按布局分别强校验，wxid 仅允许常规字符，并限制在缓存根目录内。
 */
function registerMediaProtocol(): void {
  protocol.handle('ct-media', async (request) => {
    try {
      const { pathname } = new URL(request.url)
      const { hit, badShape } = parseMediaPath(pathname)
      if (!hit)
        return new Response(badShape ? 'Not found' : 'Forbidden', { status: badShape ? 404 : 403 })
      const base = getMediaRootDir() // 规范结构：<cache>/media（ct-media 协议映射根）
      const file = resolve(base, hit.wxid, ...hit.rel)
      if (!file.startsWith(base + sep) || !existsSync(file)) {
        return new Response('Not found', { status: 404 })
      }
      return await serveMediaFile(file, request.headers.get('range'))
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1400,
    // 默认高度取较高档位(1080p 屏含任务栏仍完整可见),让三栏消息区更舒展
    height: 980,
    // 最小宽度 1024:此前是 1240 —— 那是"右栏写死 520px"时代的产物。
    // 右栏改成比例栏 + 窄窗口断点后(见 pages/workbench.css),1024 下三栏仍然成立:
    // 会话 220 | 消息 433 | 右栏 307,而旧的 1240 下限下消息区只有 312。
    // 放宽的实际意义:1920 屏左右分屏(960)、1366×768 笔记本都能用了。
    minWidth: 1024,
    minHeight: 720,
    show: false,
    autoHideMenuBar: true,
    // 隐藏原生标题栏，保留原生窗控按钮（overlay），渲染端自绘 36px 拖拽标题栏
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#00000000',
      symbolColor: '#5f6368',
      height: 36
    },
    // 防启动白闪：与渲染端底色一致
    backgroundColor: '#f5f6f7',
    title: APP_NAME,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 关闭 → 最小化到托盘（托盘菜单「退出」才真正退出）
  mainWindow.on('close', (e) => {
    if (!isQuitting) {
      e.preventDefault()
      mainWindow?.hide()
      createTray()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 聚焦后停止任务栏闪烁
  mainWindow.on('focus', () => {
    mainWindow?.flashFrame(false)
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// ── 新消息提醒（watchService 钩子）：未聚焦才提醒，节流 5s ──
function notifyNewMessage(sessionChanged: boolean): void {
  if (!getConfigBoolean('notify.enabled', true)) return
  const focused = mainWindow?.isFocused() ?? true
  if (focused) return
  mainWindow?.flashFrame(true)
  const now = Date.now()
  if (now - lastNotifyAt < 5000) return
  lastNotifyAt = now
  const n = new Notification({
    title: APP_NAME,
    body: sessionChanged ? '会话列表有更新，点击查看' : '收到新消息，点击查看',
    icon: nativeImage.createFromPath(icon),
    silent: false
  })
  n.on('click', focusMainWindow)
  n.show()
}

// ── 应用菜单（编辑 roles 保证输入框系统快捷键一致；视图含刷新/开发者工具）──
function buildAppMenu(): void {
  const menu = Menu.buildFromTemplate([
    {
      label: '文件',
      submenu: [
        {
          label: '设置',
          accelerator: 'CmdOrCtrl+,',
          click: () => mainWindow?.webContents.send('app:navigate', 'settings')
        },
        { type: 'separator' },
        {
          label: '退出',
          accelerator: process.platform === 'darwin' ? 'Cmd+Q' : 'Alt+F4',
          click: () => {
            isQuitting = true
            app.quit()
          }
        }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { label: '撤销', role: 'undo' },
        { label: '重做', role: 'redo' },
        { type: 'separator' },
        { label: '剪切', role: 'cut' },
        { label: '复制', role: 'copy' },
        { label: '粘贴', role: 'paste' },
        { label: '全选', role: 'selectAll' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '实际大小', role: 'resetZoom' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { type: 'separator' },
        { label: '切换全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于',
          click: () => {
            void dialog.showMessageBox({
              type: 'info',
              title: '关于',
              message: APP_NAME,
              detail: [
                `版本 ${app.getVersion()}`,
                `Electron ${process.versions.electron}`,
                `Chrome ${process.versions.chrome}`,
                `Node ${process.versions.node}`
              ].join('\n'),
              buttons: ['确定']
            })
          }
        }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

// 崩溃兜底尽早注册：启动早期（建库/迁移）崩掉时也要留痕，否则用户只说「软件自己关了」，
// 开发拿不到堆栈。同时记下进程启动时刻，供下面的「启动对账」判定哪些任务是上一进程遗留的。
const processStartedAt = Date.now()
installCrashGuard()

// 单实例锁：客服工作台只允许一个实例
// 必须在 app ready 之前声明自定义协议特权（bypassCSP 使 <img> 可在 CSP 下加载）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ct-media',
    privileges: { secure: true, bypassCSP: true, stream: true }
  }
])

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    focusMainWindow()
  })

  app.whenReady().then(() => {
    // 必须与 electron-builder appId 一致，否则 Windows 通知标题显示错误
    electronApp.setAppUserModelId('com.wechatcs.desktop')

    // 初始化本地库（幂等 DDL + 老库补列 + 一次性数据迁移，见 db/schema.ts）
    const tables = listTables(getDb())
    appLog.info(`db ready, tables: ${tables.join(', ')}`)
    const mig = getLastMigrateResult()
    if (mig) {
      if (mig.applied.length > 0) {
        appLog.info(`db 数据迁移 v${mig.from} → v${mig.to}: ${mig.applied.join(', ')}`)
      } else if (mig.from !== mig.to) {
        appLog.info(`db 版本对齐 v${mig.from} → v${mig.to}`)
      }
      if (mig.columnsAdded.length > 0) {
        appLog.debug(`db 补列 ${mig.columnsAdded.length} 个: ${mig.columnsAdded.join(', ')}`)
      }
    }

    // 启动对账：上一个进程留下的「运行中」任务改判 interrupted。
    // 断电/杀进程/升级重启后这些行不会被任何东西收尾，界面会一直显示「运行中」，
    // 运营以为通道还在跑，实际它再也不会自动跑（数字员工停摆最隐蔽）。
    const rec = reconcileInterruptedTasks(getDb(), processStartedAt)
    if (rec.imAudit + rec.reportRun > 0) {
      appLog.warn(`启动对账：中断任务改判 im_audit ${rec.imAudit} / report_run ${rec.reportRun}`)
    }
    // 上次是异常退出？写一条 error 日志（设置页日志可查），不再只表现为「软件自己关了」
    const crash = consumeCrashMarker()
    if (crash) {
      appLog.error(
        `检测到上次异常退出（${crash.kind} @ ${new Date(crash.at).toISOString()}）：${crash.message}；详情见 ${crash.logFile}`
      )
    }

    // 缓存目录规范化：迁移历史 wx-plain → db（幂等，启动时执行一次）
    migrateLegacyCacheLayout()

    // 敏感配置迁移：存量明文 ai.apiKey 加封为 safeStorage 密文（幂等）
    // growth.providerApiKey（第三方数据服务商）与 growth.search.apiKey（联网搜索）是两条已下线
    // 链路留下的键。这里**保留封存动作**而不是跟着删：老库里可能还躺着明文，封存一次比留在库里强；
    // 新库取不到这两个键，是空操作。同理见 services/securityPolicy.ts 的 SECRET_CONFIG_KEYS。
    migrateStoredSecrets([
      'ai.apiKey',
      'growth.providerApiKey',
      'growth.image.apiKey',
      'growth.search.apiKey'
    ])
    // 图片解密密钥（img:<wxid>:xorKey/aesKey）此前是**明文落库**：键名带账号、列不全，
    // 靠固定名单认不出来。这里按前缀把存量明文一并加封（幂等）。
    const sealedImg = migrateStoredSecretPrefixes(['img:'])
    if (sealedImg > 0) appLog.info(`已加封存量图片解密密钥 ${sealedImg} 条`)

    // 注册 IPC handlers
    registerKeyStoreHandlers()
    registerWechatHandlers()
    registerAiHandlers()
    registerSendHandlers()
    registerConfigHandlers()
    registerDialogHandlers()
    registerAppHandlers()
    registerMediaHandlers()
    registerCryptoHandlers()
    registerIssueHandlers()
    registerAgentHandlers()
    registerDutyHandlers()
    registerTeamHandlers()
    registerCustomerHandlers()
    registerImHandlers()
    registerExportHandlers()
    registerWorkbenchHandlers()
    registerLogHandlers()
    registerChannelFileHandlers()
    registerReportHandlers()
    registerLarkHandlers()
    registerFeishuNotifyHandlers()
    migrateLegacyImAudit()
    registerMediaProtocol()

    // IM 渠道(飞书等):恢复上次启用状态的账号连接
    void bootImAccounts()

    // 注入截图：里面是完整客户会话画面，无保留期会长期常驻磁盘（实测 6 张 4.8MB）
    startInjectShotsHousekeeping()
    // 渠道接收文件:启动即清一轮 + 每 6h 定时清理(防数据膨胀)
    startFileHousekeeping()
    // 媒体展示缓存 + 语音缓存:同一节奏的容量治理(归档目录不参与,见 media/mediaCache.ts)
    startMediaHousekeeping()
    // 历史归档目录迁移(散落在 media 根的归档 → archive/;非破坏、配置门控、幂等)
    try {
      migrateArchiveLayout()
    } catch (err) {
      appLog.warn(`归档目录迁移失败: ${err instanceof Error ? err.message : String(err)}`)
    }
    // 审计表保留期清理(im_audit / feishu_send_log / send_log)
    startDbHousekeeping()

    // 数据上报·定时任务:恢复启用的任务调度
    // 注: 营销的「采集订阅」调度(startGrowthScheduler)已随该链路下线删除 —— 第三方数据服务
    // 适配器从未接入，订阅注定失败，留着只是空转心跳。
    startReportScheduler()

    // 微信库变更 → 新消息提醒（节流 + 聚焦抑制）
    setOnDbChangedNotify(notifyNewMessage)

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    ipcMain.on('ping', () => appLog.debug('ipc ping -> pong'))

    createWindow()
    // 菜单必须在窗口创建之后注册（CipherTalk 注释：否则 Ctrl+, 回调会撞出第二个窗口）
    buildAppMenu()

    app.on('activate', function () {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else focusMainWindow()
    })
  })
}

// 托盘存在时关窗不退出；真退出走托盘菜单（isQuitting）
app.on('window-all-closed', () => {
  if (process.platform === 'darwin' || isQuitting) {
    app.quit()
  }
})

app.on('before-quit', () => {
  isQuitting = true
  stopReportScheduler()
  closeDb()
  stopAllWatches()
  stopIssueScheduler()
  stopBaseSyncScheduler()
  stopAllIm()
  stopFileHousekeeping() // 此前漏调:6 小时定时清理器从不清理
  stopMediaHousekeeping()
  stopDbHousekeeping()
  stopInjectShotsHousekeeping()
  stopSending()

  // 退出时的落盘数据治理。
  // 注入截图**默认清**：它只是当次排查的中间产物，却包含客户聊天画面（不需要密钥就能看）。
  // 明文库副本**默认留**：它是解密缓存，清了意味着下次启动把每个消息库重新完整解密一遍；
  // 对物理安全有要求的用户可在设置里打开 security.clearPlainCacheOnExit。
  try {
    if (getConfigBoolean('security.clearInjectShotsOnExit', true)) {
      const n = clearInjectShots()
      if (n > 0) appLog.info(`退出清理：注入截图 ${n} 张`)
    }
    if (getConfigBoolean('security.clearPlainCacheOnExit', false)) {
      const r = clearPlainDbCache()
      if (r.removed > 0) {
        appLog.info(
          `退出清理：明文库副本 ${r.removed} 个（${Math.round(r.freedBytes / 1048576)} MB）`
        )
      }
    }
  } catch (e) {
    appLog.warn(`退出清理失败（不影响退出）：${e instanceof Error ? e.message : String(e)}`)
  }
})
