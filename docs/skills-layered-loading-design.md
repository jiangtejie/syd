# 软件自身能力 Skill 化 + 分层渐进式加载设计

> 状态:**已下线(2026-09)**。AI 助手/技能/知识库相关功能整体移除:本文档仅作历史设计记录,
> 不再有对应实现。当前引擎只保留:内置微信业务工具 + 会话挂载骨架(L1/软件能力)供 IM 通道使用。

## 1. 现状盘点(代码事实)

| 项 | 现状 | 问题 |
| --- | --- | --- |
| 内置业务工具 | `skills.ts BUILTIN_TOOLS` 7 个(issue/监控/客户/消息/团队,`needsWx`) | 全部 description 每轮注入(`toolInstructionsText`) |
| 自定义 HTTP 工具 | `customTools.ts`,全部进 system | 同上,随数量线性膨胀 |
| 第三方声明式技能 | `skillsPack.ts` tool 类全量进 system;knowledge 类全量 ≤1500 字 | 同上 |
| MCP | `mcp.ts` 惰性握手后工具全量进 system(描述 ≤300/个) | server 越多越重 |
| 上下文预算 | 历史 48k 字符 / 40 行 / 单条 6k | 只约束历史,**不约束 system 工具段** |
| 原生协议 | 每轮 schemas = 全部 defs | 同上 |
| 会话映射/记忆 | chat_session(wxid,title,agent_id…) | 无可持久化挂载位 |

结论:工具规模小时够用;**工具一多(软件能力 + 自定义 + 技能包 + MCP)system 工具段会挤压历史预算**,且模型每轮被迫“认识”大量用不上的工具,决策噪音大。没有“目录/挂载/卸载”机制。

## 2. 参考项目评估(哪些能落地)

依据:HappyClaw(Claude SDK agent-runner/技能运行时,已实地核对源码)与 Claude Code Skills 生态惯例。

| 参考点 | 内容 | 落地判断 |
| --- | --- | --- |
| Effective manifest / run_context 快照 | 每回合宿主注入权威块,说明当前生效能力/预算,不让模型猜 | ✅ 落地:每轮注入精简 `<capability_snapshot>` 权威块 |
| 显式技能选择(selectedSkillIds) | 只把“选中技能”注入子请求,而非全量 | ✅ 落地:会话挂载集(mounted set),是本次核心 |
| Skill 目录优先 | SKILL.md 名+描述=目录;描述自包含(何时用/用法),调用即契约 | ✅ 落地:元技能 `list_capabilities` 返回紧凑目录;描述按此规范重写 |
| 同名冲突/ghost/orphan 管理 | 低优先级同名被高优先级覆盖,失效项移出并清理 | ⚠️ 改造落地:统一 Registry,内置名不可被覆盖;技能包安装时同名即拒(一期已有雏形,补强) |
| catalog 版本/hash 校验 | `.catalog.json` 校验来源/清单/内容哈希,防半旧目录 | ⚠️ 已半落地(skills 一期);二期给第三方技能补 hash 校验 |
| context budget/trim + 超限行为 | 单独预算与超限处理,不静默 | ✅ 落地:挂载追加独立预算(≤6k),超限返回可行动提示 |
| 知识/资源类注入受控 | knowledge ≤400/条、≤1500 总 | ✅ 已落地;渐进化后按主题触发 |
| 子 agent/subagent 委托 | 子请求带专属 prompt+技能 | ❌ 本引擎无 subagent 架构,成本高,不做(远期) |
| 容器/文件系统挂载技能 | 文件读写技能 | ❌ 违背“无任意代码”安全模型,不做 |
| proactive/后台任务技能 | 主动回合 | ❌ 与“发送保持人工闸门”冲突,不做 |

## 3. 分层模型(最终)

```
L0 内核(任何会话常驻,~3KB)
  身份/风格/记忆 + ReAct 协议 + 渠道说明(IM/微信) + 安全规则
  <capability_snapshot> 权威块:账号、会话对象、当前分层、挂载集、剩余预算
  元技能(只读、无副作用,常驻且仅此 2 个常驻):
    list_capabilities(scope)   —— 目录:name+一句话用途+适用时机+tier+成本+是否只读
    mount_capability(name,why) —— 挂载 L2/L3 项到本会话(卸载:unmount_capability)

L1 账号默认集(仅 wxid 非空时常驻,~3KB,desc 精简到 ≤120/个)
  现 7 个微信业务工具(needsWx)。IM/通用会话不注入(现状已按 needsWx 禁用)。

L2 软件自身深层能力(目录可见,按需挂载;全部只读)
  内置新增,读现有只读 repo/服务,不新增写能力:
    software_status   软件版本/微信账号与通道连接/CS 库就绪/模型与智能体配置摘要
    data_scope        数据覆盖:账号、群数/客户数、消息时间范围、监控开启状态
    bi_stats          会话/消息/问题量、今日新增、趋势与排行(复用看板口径)
    im_channels_status IM 渠道账号连接状态与会话映射概况
    memory_view       查看常驻记忆与知识技能清单(只读)
    export_preview    可导出数据范围估算(不执行导出)
L3 知识/外部(挂载或主题触发)
  第三方 tool 技能(kind=skill)与自定义 HTTP:挂载后可调用,确认闸门不变
  第三方 knowledge:主题触发注入(≤600/次)
  MCP:server 目录化,懒挂载后握手
```

## 4. 加载机制(工程方案)

### 4.1 能力注册表 Registry
`capability: { name, desc, when(何时用), tier, needsWx, confirm, readOnly, group, estChars, resolve(): ToolDef|text }`
- 内置:由 BUILTIN_TOOLS 派生并补元数据;`skills.ts` 描述按“用途+何时用”规范重写(≤120 字/条)。
- 外部(custom/pack/MCP):包装层默认 `tier=L3`、`readOnly=取决于实现`(确认型保持 confirm)。
- 解析优先级:内置 > 会话挂载 > 自定义 > 第三方技能 > MCP(名称冲突策略固定,安装端同名拒绝)。
- 文本与原生两通道共用 Registry 与 mounted set,行为一致。

### 4.2 挂载协议(JSON 文本通道)
- system = L0 + L1(绑定) + 已挂载项说明;L2/L3 不在 system,只在目录里出现一次。
- 模型需要时调用 `mount_capability(name, why)`(只读动作,无需人工确认):
  校验 tier 规则与预算 → 加入 `mounted[sessionId]` → 返回“已挂载,用途:…,现可调用以下工具/使用以下知识”并附该能力完整说明 → 引擎把该说明补进**当轮 turns**(不是历史落库),下一轮起随 system 携带。
- `unmount_capability(name)` / 空闲回收:连续 2 轮未被引用自动卸载(回收结果作为观察提示)。
- 预算:同会话最多 8 项挂载、追加说明总量 ≤6k 字符(常量 `MOUNT_MAX`/`MOUNT_TEXT_BUDGET`),超限返回“容量不足,请先卸载…”。
- 挂载集随会话删除/清空/停止重置;会话内每轮仍受历史 48k 预算约束(工具段占用从预算中预留告警线,见 4.4)。

### 4.3 原生 function-calling 通道
- schemas = L0 元技能 + L1(绑定) + 已挂载项;模型调用 mount → 引擎挂载后把新能力说明写入 wire(工具结果),下一轮请求携带新 schemas。
- 与现有双协议/降级逻辑兼容:挂载集在 `runTurn/runTurnNative` 之间共享,降级切换不丢挂载。

### 4.4 预算与权威块
- 每轮开头注入(≤500 字):`<capability_snapshot channel=… account=… tier=L0|L1|L2… mounted=[…] history_budget=48k mounted_text=…k>`
- 工具段常驻+挂载总量软上限 8k;历史压缩触发阈值按“工具段+历史”合并计算,防挤压。
- 事件与 UI:mount/list/unmount 动作如普通工具卡展示(thought/args/result);工具卡可跳转技能页。

### 4.5 管理面(SkillsPage 升级)
- 分区:内置能力(软件自身,按 tier 分组)/第三方技能包/自定义工具/MCP;每项:名称、tier 徽标、只读/确认标记、用途(何时用)、启用开关、本会话挂载状态与操作。
- 内置 L2 项允许“整体停用某能力”(写 `skill_package`-like 配置或 config key),默认全开。

## 5. 安全与不变量
- 新增能力全部**只读**,复用既有 repo/服务函数;不新增任何“执行/写”内置工具。
- 外部技能保持:http-only + 人工确认 + 无任意代码;挂载动作本身只读、无需确认。
- 发送与外部副作用依旧人工闸门,IM 通道只读+确认规则不变。
- 目录不泄露敏感明细(只说“存在/范围”),明细要调用后才进上下文。

## 6. 落地切片(建议 P0 一次完成核心)

- **P0(核心,推荐本次落地)**:Registry + tier 元数据 + `list_capabilities`/`mount/unmount` 元技能 + snapshot 权威块;L1 desc 精简;L2 新增 5 个软件能力(software_status/data_scope/bi_stats/im_channels_status/memory_view,以现有只读函数实现);两通道挂载协议+预算+空闲回收;技能页分层视图。
- **P1(下一轮)**:热词/会话预挂载(群对象→L1,监控语境→bi_stats)、挂载集持久化(`chat_session` 增列)、knowledge 主题触发注入、技能包 hash 校验。
- **P2(远期)**:MCP server 目录化懒挂载、能力搜索与使用建议、子技能文档接入。

## 7. 验收口径
1. 长上下文会话(>30k 历史)+ 装 10 个第三方工具 + 2 个 MCP 时,system 工具段不再随工具数线性膨胀(只随“已挂载”增长)。
2. 问“软件能不能看数据/有几天数据”→ 模型先 `list_capabilities`→`mount_capability(data_scope)`→正确回答,过程无多余工具调用。
3. 问业务问题(绑定态)→ 直接走 L1 工具,不经目录(零额外步骤)。
4. 原生通道与 JSON 通道行为一致;工具卡完整展示目录/挂载动作;卸载/回收有提示。
5. 只读边界:新能力调用不产生任何写操作;第三方确认闸门不变。
