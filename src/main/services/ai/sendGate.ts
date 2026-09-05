import { getConfig } from '../../db/repos/config'

/**
 * 智能体发送微信消息的统一闸门(总开关 + 审批开关)。
 * - send.agentEnabled:总开关(默认开);关闭后 send_message 工具直接返回未开启
 * - send.approve:逐次审批开关(默认开);关闭后不再弹确认,直接发送(仍受频控/审计)
 */

export const SEND_TOOL_NAME = 'send_message'

export function sendAgentEnabled(): boolean {
  return getConfig('send.agentEnabled') !== '0'
}

export function sendApproveEnabled(): boolean {
  return getConfig('send.approve') !== '0'
}
