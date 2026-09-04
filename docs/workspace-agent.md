# 工作区 Agent(本地自动化副驾)v1

> 桌面入口“工作区”(导航 AI 之后):把本地目录交给 AI 干活的 Claude Code 风格通道。
> 与客服 AI 助手(会话/能力分层/记忆)完全隔离,单独表、单独事件通道、单独确认闸门。
> 参考:Claude Code 形态、CipherTalk/HappyClaw 的工具-确认模式(仅思路)。

## 数据模型(cs.db 新表)
- `workspace_session(id, cwd, title, created_at, updated_at)`:每会话绑定一个工作目录;
- `workspace_message(id, session_id, role, kind, content, meta, created_at)`:会话消息(tool_call/tool_result 与正文同表,kind 区分),与 `chat_session` 互不相通。

## 进程与 IPC
- `services/workspace/tools.ts`:受限工具集与项目上下文
  - 只读(常驻直用):`read_file`(行区间/2MB 上限/二进制拦截)、`list_dir`、`glob`、`grep`;
  - 写入/执行(每次人工确认,60s 超时拒绝):`write_file`(≤4MB)、`edit_file`(精确替换/replace_all)、`run_command`(cmd,工作区 cwd,5–600s);
  - 所有路径经 `resolveIn` 校验必须在工作区内;隐藏目录(node_modules/.git/dist 等)跳过;
  - 项目上下文自动注入:CLAUDE.md/AGENTS.md(各 ≤2400 字)+ README.md(≤1500)+ 前两层目录树。
- `services/workspace/runner.ts`:JSON 文本工具协议引擎(「思考:」+ `{"tool","args"}`),决策 ≤6 轮,
  [工具结果] 回填,最终轮流式正文;事件统一 `webContents.send('ai:ws', …sessionId)`;运行期 Map 防并发;确认闸门 `pendingConfirm(runId)` 60s;usage/reasoning 收集;重试清理尾部残留。
- `ipc/workspaceHandlers.ts` + preload `cs.ws`:list/create/rename/remove/messages/send/retry/stop/confirm/preview;模型沿用 设置 → AI 通道 配置(OpenAI 兼容任意模型/中转)。

## 渲染
- `stores/workspace.ts`(zustand):会话/消息/流式缓冲/工具卡/确认;`subscribeWorkspaceEvents()` 订阅 `ai:ws`,按 `sessionId` 过滤,`done/error/已停止` 后自动重拉消息落库正文;
- `pages/WorkspacePage.tsx`:布局复用 `ai.css`(侧栏+气泡+工具卡+composer),补充 `workspace.css`(工作区信息条/路径 chip);工具卡 pending 态带“允许执行/拒绝”。

## 安全边界(与客服域承诺一致)
- 无任意代码执行:命令/写盘必须逐次人工确认并限定工作区内;只读能力常驻;
- 会话内容与客服会话隔离;删除会话不删文件;
- 长命令默认 120s 超时、输出截断 6k,防挂死与刷屏。

## 验证口径
1. 新建工作区选目录 → 问“这个目录是做什么的” → 读 README/目录树回答(无工具确认);
2. “帮我 grep 出 xxx 的调用点” → 直接 grep 回填;
3. “把 README 标题改成 X” → write/edit 弹确认 → 允许后写入并回报;
4. “跑一下 npm test”(若目录是仓库)→ run_command 弹确认 → 输出回填;
5. 拒绝/超时确认 → 模型收到“未获确认”,不再重试同操作;停止按钮可中断。
