/** 设置页「人设表单」脏标记(独立小模块,避免组件文件导出非组件内容) */

let agentDirty = false

export function setAgentFormDirty(v: boolean): void {
  agentDirty = v
}

export function agentFormDirty(): boolean {
  return agentDirty
}
