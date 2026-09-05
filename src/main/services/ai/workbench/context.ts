import { getDefaultAgent } from '../../../db/repos/agentRepo'
import { buildToolMenuText } from './tools'
import { skillsCatalogText, skillsInjectionText } from './skills'
import { memoSystemBlock } from '../memo'

/**
 * 工作台 system 组装:
 * 固定段(人设+规则+工具组菜单+技能目录,跨轮不变 → prompt-cache 友好)
 * + 动态段(账号状态 + 启用技能全文 + 运营备忘;只在变化时改变)。
 */

const RULES = [
  '你是「工作台助手」:在微信私域客服软件里帮助运营者查询业务数据、分析问题、整理口径。',
  '回答要基于事实、简洁、用中文;不确定时明确说明,不编造。',
  '所有查询都是只读的,不会修改任何业务数据;账号上下文由系统注入,不要询问用户 wxid。',
  '引用溯源:多行工具结果会被系统逐行加 [编号](本回合内跨工具依次累加,仅本轮有效)。回答引用具体行(客户原话、数字、时间、单条结论)时,在该句末尾标注对应编号,如「…运费问题需今日跟进[3]」或「…共两条:运费[1]、到货[2]」;编号必须真实对应你实际看到的行,不得编造、不得张冠李戴;同一句至多标注 5 个编号,无编号来源的行直接转述即可。'
].join('\n')

export function buildWorkbenchSystem(
  wxid: string,
  extras: { summary?: string | null } = {}
): string {
  const agent = getDefaultAgent()
  const persona = agent
    ? `${agent.prompt ? `${agent.prompt}\n` : ''}你是「${agent.name}」:${agent.description || '客服智能体'}。风格:${agent.style ?? 'warm'}。`
    : ''
  const parts = [RULES, persona, buildToolMenuText()]
  const catalog = skillsCatalogText()
  if (catalog) {
    parts.push(`可用业务技能(启用者会按技能口径执行):\n${catalog}`)
  }
  parts.push(
    `当前账号:${(wxid || '').trim() ? '已绑定(业务查询可用)' : '未绑定(仅软件状态可用;业务查询会提示先连接账号)'}`
  )
  const injection = skillsInjectionText()
  if (injection) parts.push(injection)
  const memo = memoSystemBlock()
  if (memo) parts.push(memo)
  if (extras.summary) {
    parts.push(`# 较早对话摘要(均发生在本次提问之前)\n${extras.summary}`)
  }
  return parts.filter((p) => p.trim().length > 0).join('\n\n')
}
