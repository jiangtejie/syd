/**
 * 取 key 工具预设（纯逻辑：匹配文件名 + 展开参数模板）。
 *
 * 为什么是「预设 + 多模板」而不是写死一条命令：这类工具的 CLI 会随版本变（参数名、子命令都可能变），
 * 我们**不依赖**自己记得准 —— 每个预设给几个常见模板，按顺序试，**能否采用一律由真实库的页 1 HMAC 决定**。
 * 试错的成本只是多跑一次命令，而错误结果永远进不了密钥库。
 */

export interface KeyToolPreset {
  id: string
  name: string
  /** 可执行文件名（不含扩展名，小写）。扩展名由 TOOL_EXTS 决定：.exe / .cmd / .bat / 无扩展 */
  stems: string[]
  /** 按顺序尝试的参数模板；`{{wxid}}` 等占位符会被替换 */
  argTemplates: string[][]
  /** 展示给用户的说明 */
  note: string
  /** 上游许可（记录用，本仓不分发这些工具） */
  license?: string
}

/**
 * 认哪些扩展名：Python/Node 类工具在 Windows 上常装成 .cmd 包装器（实测 execFile 直接跑 .cmd 会 EINVAL，
 * 我们走 cmd.exe 包装），所以检测时不能只认 .exe —— 这是实测踩出来的坑。
 */
const TOOL_EXTS = new Set(['', '.exe', '.cmd', '.bat'])

export const KEY_TOOL_PRESETS: KeyToolPreset[] = [
  {
    id: 'chatlog',
    name: 'chatlog',
    stems: ['chatlog'],
    argTemplates: [['key'], ['--debug', 'key']],
    note: 'Go 编写的微信聊天记录工具，chatlog key 会输出数据密钥；本仓不分发',
    license: 'MIT（sjzar/chatlog）'
  },
  {
    id: 'pywxdump',
    name: 'PyWxDump',
    stems: ['wxdump', 'pywxdump'],
    argTemplates: [['wx_key'], ['key'], ['info']],
    note: '经典取密钥工具（本仓不分发）；不同版本子命令可能是 wx_key / key，按顺序试，取到就校验',
    license: '见上游仓库（本仓不分发）'
  },
  {
    id: 'wxkey',
    name: 'wx_key',
    stems: ['wx_key', 'wxkey', 'wechat_key', 'wechat_key_tool'],
    argTemplates: [[]],
    note: '微信 4.0 密钥/图片密钥提取工具（ycccccccy/wx_key 一类，本仓不分发），无参运行即输出',
    license: '见上游仓库（本仓不分发）'
  },
  {
    id: 'sharpwxdump',
    name: 'SharpWxDump',
    stems: ['sharpwxdump', 'wxdump64', 'wxdump32'],
    argTemplates: [[]],
    note: 'C# 版工具（本仓不分发），常无参运行直接打印密钥',
    license: '见上游仓库（本仓不分发）'
  }
]

/**
 * 按文件名匹配预设（大小写不敏感；扩展名必须是 .exe/.cmd/.bat/无）。
 * 未命中返回 null —— 那说明它可能是别的工具，仍可用通用 externalTool 接。
 */
export function matchPreset(fileName: string): KeyToolPreset | null {
  const name = (fileName || '').trim().toLowerCase()
  if (!name || name.includes('/') || name.includes('\\')) {
    // 允许传完整路径：只取文件名部分
    const base = name.split(/[\\/]/).pop() ?? ''
    if (!base) return null
    return matchPreset(base)
  }
  const dot = name.lastIndexOf('.')
  const ext = dot >= 0 ? name.slice(dot) : ''
  if (!TOOL_EXTS.has(ext)) return null
  const stem = dot >= 0 ? name.slice(0, dot) : name
  for (const preset of KEY_TOOL_PRESETS) {
    if (preset.stems.includes(stem)) return preset
  }
  return null
}

/** 预设 id → 预设 */
export function presetById(id: string): KeyToolPreset | null {
  return KEY_TOOL_PRESETS.find((p) => p.id === id) ?? null
}

/** 判断某个文件名是否像「取 key 工具」（用于自动发现时筛选） */
export function looksLikeKeyTool(fileName: string): boolean {
  return matchPreset(fileName) !== null
}
