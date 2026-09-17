/**
 * AI 调用计量（ai_run）的表与索引。
 *
 * 为什么单独一个模块：它不属于「核心业务表」也不属于 growth 域，是横切的运行时观测数据；
 * 单独成文件也让「加观测字段」不必再动几百行的 base.ts。
 *
 * 一次**真实** LLM 请求一行（重试的每次尝试都算一次调用，因为每次都真的计费）。
 * 以前 token 只写在单条消息的 meta 里，全仓没有任何聚合查询 —— 于是
 * 「昨天失败几次 / 哪个模块总失败 / 这个月烧了多少」一个都答不出来。
 */
export const AI_TABLES: string[] = [
  `CREATE TABLE IF NOT EXISTS ai_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    at INTEGER NOT NULL,
    module TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL DEFAULT '',
    ok INTEGER NOT NULL DEFAULT 1,
    error_kind TEXT NOT NULL DEFAULT '',
    error_code TEXT NOT NULL DEFAULT '',
    latency_ms INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 1,
    tokens_in INTEGER NOT NULL DEFAULT 0,
    tokens_out INTEGER NOT NULL DEFAULT 0
  )`
]

export const AI_INDEXES: string[] = [
  // 面板都是「近 N 天 / 按模块」两种访问形态，各配一条
  `CREATE INDEX IF NOT EXISTS idx_ai_run_at ON ai_run (at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ai_run_module ON ai_run (module, ok)`
]
