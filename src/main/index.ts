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
import { existsSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { getDb, closeDb, getLastMigrateResult } from './db/database'
import { getGrowthMediaDir, getMediaRootDir, migrateLegacyCacheLayout } from './services/paths'
import { migrateStoredSecrets } from './services/secrets'
import { listTables } from './db/schema'
import { startDbHousekeeping, stopDbHousekeeping } from './db/housekeeping'
import { getConfigBoolean } from './db/repos/config'
import { registerKeyStoreHandlers } from './ipc/keyStoreHandlers'
import { registerWechatHandlers } from './ipc/wechatHandlers'
import { registerAiHandlers } from './ipc/aiHandlers'
import { registerSendHandlers } from './ipc/sendHandlers'
import { registerConfigHandlers } from './ipc/configHandlers'
import { registerDialogHandlers } from './ipc/dialogHandlers'
import { registerAppHandlers } from './ipc/appHandlers'
import { registerMediaHandlers } from './ipc/mediaHandlers'
import { registerIssueHandlers } from './ipc/issueHandlers'
import { registerAgentHandlers } from './ipc/agentHandlers'
import { registerDutyHandlers } from './ipc/dutyHandlers'
import { registerTeamHandlers } from './ipc/teamHandlers'
import { registerImHandlers, bootImAccounts, stopAllIm } from './ipc/imHandlers'
import { registerExportHandlers } from './ipc/exportHandlers'
import { registerWorkbenchHandlers } from './ipc/workbenchHandlers'
import { registerLogHandlers } from './ipc/logsHandlers'
import { registerChannelFileHandlers } from './ipc/channelFileHandlers'
import { registerReportHandlers } from './ipc/reportHandlers'
import { registerGrowthHandlers } from './ipc/growthHandlers'
import { registerGrowthAiHandlers } from './ipc/growthAiHandlers'
import { registerGrowthBuzzHandlers } from './ipc/growthBuzzHandlers'
import { registerLarkHandlers } from './ipc/larkHandlers'
import { migrateLegacyImAudit } from './db/repos/imAuditRepo'
import { registerFeishuNotifyHandlers } from './ipc/feishuNotifyHandlers'
import { startReportScheduler, stopReportScheduler } from './services/report/scheduler'
import { startGrowthScheduler, stopGrowthScheduler } from './services/growth/scheduler'
import { createLogger } from './services/logging'
import { startFileHousekeeping, stopFileHousekeeping } from './services/im/channelFiles'

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

const APP_NAME = '微信私域智能客服'

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
 * 自定义 media 协议：把缓存目录的已解密媒体以 ct-media://media/<wxid>/<文件名> 暴露给渲染层。
 * dev 渲染源是 http://localhost，file:// 子资源会被 Chromium 拦截，故统一走协议。
 * 安全：文件名强校验（md5_kind.ext），wxid 仅允许常规字符，并限制在缓存根目录内。
 */
function registerMediaProtocol(): void {
  protocol.handle('ct-media', (request) => {
    try {
      const { pathname } = new URL(request.url)
      const seg = pathname.split('/').filter(Boolean)
      if (seg.length !== 2) return new Response('Not found', { status: 404 })
      const wxid = decodeURIComponent(seg[0])
      const name = decodeURIComponent(seg[1])
      if (!/^[a-zA-Z0-9_@.-]+$/.test(wxid)) return new Response('Forbidden', { status: 403 })
      if (!/^[0-9a-f]{32}_[a-z0-9]+\.(jpe?g|png|gif|webp|mp4|mkv|avi|mov|m4v)$/i.test(name)) {
        return new Response('Forbidden', { status: 403 })
      }
      const base = getMediaRootDir() // 规范结构：<cache>/media（ct-media 协议映射根）
      const file = resolve(base, wxid, name)
      if (!file.startsWith(base + sep) || !existsSync(file)) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(file).toString())
    } catch {
      return new Response('Bad request', { status: 400 })
    }
  })
}

const growthProtoLog = createLogger('growth-proto')

/**
 * 自定义 growth 媒体协议: 把 <cache>/growth/media 下已下载的素材图以
 * ct-growth://<sub>/<file> 暴露给渲染层(校验与 ct-media 同规格: 路径强白名单)。
 */
function registerGrowthMediaProtocol(): void {
  protocol.handle('ct-growth', (request) => {
    const { pathname } = new URL(request.url)
    // 每张素材图一次请求:降到 debug(打包环境不写),否则滚动列表会刷爆日志
    growthProtoLog.debug('ct-growth 请求: ' + pathname)
    try {
      const seg = pathname.split('/').filter(Boolean)
      if (seg.length !== 2) return new Response('Not found', { status: 404 })
      const sub = decodeURIComponent(seg[0])
      const name = decodeURIComponent(seg[1])
      if (!/^[0-9a-f]{2}$/.test(sub)) return new Response('Forbidden', { status: 403 })
      if (!/^[0-9a-f]{40}\.(jpe?g|png|webp|gif|mp4|mov|webm|m4v)$/i.test(name)) {
        return new Response('Forbidden', { status: 403 })
      }
      const base = getGrowthMediaDir()
      const file = resolve(base, sub, name)
      if (!file.startsWith(base + sep) || !existsSync(file)) {
        return new Response('Not found', { status: 404 })
      }
      return net.fetch(pathToFileURL(file).toString())
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
    // 右栏(群问题/回复建议)加宽至 520px 后,消息区仍需保有可用宽度
    minWidth: 1240,
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

// 单实例锁：客服工作台只允许一个实例
// 必须在 app ready 之前声明自定义协议特权（bypassCSP 使 <img> 可在 CSP 下加载）
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'ct-media',
    privileges: { secure: true, bypassCSP: true, stream: true }
  },
  {
    scheme: 'ct-growth',
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

    // 缓存目录规范化：迁移历史 wx-plain → db（幂等，启动时执行一次）
    migrateLegacyCacheLayout()

    // 敏感配置迁移：存量明文 ai.apiKey 加封为 safeStorage 密文（幂等）
    migrateStoredSecrets([
      'ai.apiKey',
      'growth.providerApiKey',
      'growth.image.apiKey',
      'growth.search.apiKey'
    ])

    // 注册 IPC handlers
    registerKeyStoreHandlers()
    registerWechatHandlers()
    registerAiHandlers()
    registerSendHandlers()
    registerConfigHandlers()
    registerDialogHandlers()
    registerAppHandlers()
    registerMediaHandlers()
    registerIssueHandlers()
    registerAgentHandlers()
    registerDutyHandlers()
    registerTeamHandlers()
    registerImHandlers()
    registerExportHandlers()
    registerWorkbenchHandlers()
    registerLogHandlers()
    registerChannelFileHandlers()
    registerReportHandlers()
    registerGrowthHandlers()
    registerGrowthAiHandlers()
    registerGrowthBuzzHandlers()
    registerLarkHandlers()
    registerFeishuNotifyHandlers()
    migrateLegacyImAudit()
    registerMediaProtocol()
    registerGrowthMediaProtocol()

    // IM 渠道(飞书等):恢复上次启用状态的账号连接
    void bootImAccounts()

    // 渠道接收文件:启动即清一轮 + 每 6h 定时清理(防数据膨胀)
    startFileHousekeeping()
    // 审计表保留期清理(im_audit / feishu_send_log / send_log)
    startDbHousekeeping()

    // 数据上报·定时任务:恢复启用的任务调度
    startReportScheduler()
    startGrowthScheduler()

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
  stopGrowthScheduler()
  closeDb()
  stopAllWatches()
  stopIssueScheduler()
  stopAllIm()
  stopFileHousekeeping() // 此前漏调:6 小时定时清理器从不清理
  stopDbHousekeeping()
  stopSending()
})
