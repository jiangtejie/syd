/**
 * ── douyin-cookie: ttwid 捕获与持久化(桌面端=进程内存) ── vendor: 抖音/小红书 分享链接解析内核(移植自 parse.shenzjd.com / 神族九帝) ──
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

import { logger } from "./shared.js";

// 桌面端移植: 原实现用 Turso kv_store 持久化 ttwid; 桌面端改为进程内内存
// (稳定性诉求一致: 同一应用会话内复用同一组 ttwid, 重启后重新握手即可)。
let memoryTtwid = "";

export function extractDouyinTtwid(response) {
  try {
    const setCookies = [];
    if (typeof response.headers.getSetCookie === "function") {
      setCookies.push(...response.headers.getSetCookie());
    } else {
      for (const [key, value] of response.headers.entries()) {
        if (key.toLowerCase() === "set-cookie") setCookies.push(value);
      }
    }
    for (const sc of setCookies) {
      const match = sc.match(/ttwid=([^;]+)/);
      if (match) return `ttwid=${match[1]}`;
    }
  } catch (e) {
    logger.warn(`[douyin-cookie] 提取 ttwid 失败: ${e.message}`);
  }
  return "";
}

/**
 * 读取持久化的抖音 ttwid。
 * @returns {Promise<string>} 持久化的 ttwid Cookie 串，无则返回 ""
 */

/**
 * 读取当前进程持有的 ttwid(原 Turso 读取的桌面端替代)。
 * @returns {Promise<string>} Cookie 串, 无则返回 ""
 */
export async function getDouyinTtwid() {
  return memoryTtwid;
}

/**
 * 保存 ttwid 到进程内存(upsert 语义)。
 * @param {string} ttwid 形如 "ttwid=xxx"
 */
export async function saveDouyinTtwid(ttwid) {
  if (!ttwid) return;
  memoryTtwid = ttwid;
  logger.log("[douyin-cookie] ttwid 已更新(进程内)");
}

/** 重置(测试/调试用) */
export function resetDouyinTtwid() {
  memoryTtwid = "";
}
