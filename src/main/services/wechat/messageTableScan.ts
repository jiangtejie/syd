/**
 * 微信消息表命中的判定（纯函数，零依赖，可离线自检）。
 *
 * 背景：消息表名是 `msg_<md5(会话名)>`（32 位小写 hex）。读取层靠这个命名去找表，而
 * 一张都没命中时**以前会静默返回空数组**（`{ ok: true, messages: [] }`）。微信改版、
 * 分片策略变化、表名长度/大小写变化时，群消息、待回复队列、议题分析、数字员工值班、
 * 发送闭环校验会集体「0 条消息」，而界面与日志都说 ok —— 运营侧表现为「群里明明有人说话，
 * 系统说没有」，且没有任何可诊断线索。这个模块把那件事变成一条显式错误。
 */

/** `msg_<32hex>` → 返回小写 hex；不是这个形状返回 null（形状变了本身就是改版信号） */
export function messageTableHashOf(tableName: string): string | null {
  const m = /^msg_([0-9a-f]{32})$/i.exec(tableName ?? '')
  return m ? m[1].toLowerCase() : null
}

export interface MessageTableScan {
  /** 成功打开的库数（打不开的不计入，避免把「密钥/路径问题」误报成「改版」） */
  openedDbs: number
  /** 库里以 msg_ 开头的候选表数 */
  candidateTables: number
  /** 其中符合 `msg_<32hex>` 命名的表数 */
  hashedTables: number
  /** 其中命中目标会话的表数 */
  matchedTables: number
}

export type MessageTableVerdict = { ok: true } | { ok: false; error: string }

/**
 * 判定这次扫描能不能信。
 *
 * 只有一种情况判「不可信」：**打开了库、却一张 `msg_<32hex>` 表都没有** ——
 * 消息库里不可能没有消息表，只剩命名规则变了这一种解释。
 * 「有这类表但没命中目标会话」不算错：那个会话可能确实还没消息，照常返回空。
 */
export function judgeMessageTableScan(scan: MessageTableScan): MessageTableVerdict {
  if (scan.openedDbs === 0) {
    return { ok: false, error: '消息库打开失败（无可用数据库）：请检查微信数据路径与密钥' }
  }
  if (scan.hashedTables === 0) {
    return {
      ok: false,
      error:
        '未匹配到消息表（msg_<32位hex>）：已扫描 ' +
        String(scan.openedDbs) +
        ' 个消息库 / ' +
        String(scan.candidateTables) +
        ' 个 msg_ 候选表，命名均不符，微信版本或库结构可能已变更'
    }
  }
  return { ok: true }
}
