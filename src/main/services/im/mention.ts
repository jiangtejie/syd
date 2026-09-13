/**
 * 飞书文本消息里的 @人（**纯函数，零依赖**，可离线自检）。
 *
 * 飞书 text 消息的 @ 是内容里的标签：`<at user_id="ou_xxx">名字</at>`（`user_id="all"` 为 @所有人）。
 * 名字只用于渲染，但**必须转义尖括号与引号**，否则标签会被截断、整条消息变成一串乱码 —— 这类问题
 * 只在真实群里才看得出来，所以这里把拼接规则固化成纯函数并进自检。
 */

/** @所有人 */
export function atAll(name = '所有人'): string {
  return `<at user_id="all">${safeName(name)}</at>`
}

/**
 * 单个 @：open_id 合法就返回标签，否则返回空串（调用方回落到纯文本名字）。
 * 只接受 `ou_` 形态的 open_id：传错（比如用户名、邮箱）时宁可不 @，也不要发出坏标签。
 */
export function atTag(openId: string | null | undefined, name?: string): string {
  const id = (openId ?? '').trim()
  if (id === 'all') return atAll(name)
  if (!/^ou_[0-9a-zA-Z_-]{6,}$/.test(id)) return ''
  return `<at user_id="${id}">${safeName(name)}</at>`
}

/** 把若干 @ 拼到正文前面（换行分隔），没有可用的 @ 时原样返回 */
export function withMentions(text: string, tags: string[]): string {
  const list = tags.map((t) => (t ?? '').trim()).filter(Boolean)
  if (list.length === 0) return text
  return list.join(' ') + '\n' + text
}

/** 标签内部的名字：去掉会破坏标签的字符，并限制长度 */
function safeName(name?: string): string {
  const clean = (name ?? '').replace(/[<>"]/g, '').trim()
  return clean.slice(0, 24) || '同事'
}
