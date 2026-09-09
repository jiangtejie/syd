/**
 * ── vendor: 抖音/小红书 分享链接解析内核(移植自 parse.shenzjd.com / 神族九帝) ──
 * 来源: https://github.com/wu529778790/parse.shenzjd.com (lib/parsers + douyin-extract)
 * 移植说明(桌面端 wechat-cs-desktop growth 域):
 *  1. 仅保留解析内核, 剥离 Next.js/Turso/API 中间件等宿主壳;
 *  2. 日志统一走仓库 services/logging(shared.js), 便于设置页日志查看;
 *  3. 抖音 ttwid 改为进程内内存持久(替代 Turso kv_store), 应用重启后重新握手;
 *  4. 抖音「公共解析兜底(douyinPublicFallback)」默认关闭(ENABLE_PUBLIC_FALLBACK=false);
 *  5. 小红书图片不再走站内代理, 直接返回原 https 直链(桌面端本地下载时自带 Referer);
 *  6. 用途: 用户粘贴自己看到内容的分享链接、低频解析入库 —— 不做批量对抗抓取。
 * 合规: 本模块访问平台公开分享页(游客态匿名 ttwid), 属灰色地带, 批量/商用请走官方/数据服务商。
 */

import { createLogger } from '../../../logging'

/**
 * 替代原 api-utils.js 中解析器所需的最小公共件:
 * logger / beijingNow / DELETED_CONTENT_MSG。
 */

export const DELETED_CONTENT_MSG = '该内容已被删除'

const l = createLogger('growth-resolver')

export const logger = {
  log: (...args) => l.debug(args.map(fmtArg).join(' ')),
  info: (...args) => l.debug(args.map(fmtArg).join(' ')),
  warn: (...args) => l.warn(args.map(fmtArg).join(' ')),
  error: (...args) => l.error(args.map(fmtArg).join(' '), undefined)
}

function fmtArg(a) {
  if (a instanceof Error) return a.message
  if (typeof a === 'object') {
    try { return JSON.stringify(a).slice(0, 500) } catch { return String(a) }
  }
  return String(a)
}

export function beijingNow() {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
  return fmt.format(new Date()).replace(/\//g, '-')
}
