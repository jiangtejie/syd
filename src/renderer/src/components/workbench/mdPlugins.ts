import remarkGfm from 'remark-gfm'

/**
 * 富文本 remark 插件集(纯逻辑,渲染组件见 mdRender.tsx):
 * - remark-gfm: 表格 / 任务清单 / 删除线 / 自动链接
 * - remarkCalloutPlugin: GitHub 风格告警块 `> [!NOTE] / [!TIP] / [!IMPORTANT] / [!WARNING] / [!DANGER]`
 *   解析为彩色提示卡(md-callout),样式见 workbench-chat.css「富文本组件主题」。
 */

/** 告警关键字 → 语义类名 */
const CALLOUT_KINDS: Record<string, string> = {
  NOTE: 'note',
  TIP: 'tip',
  IMPORTANT: 'important',
  WARNING: 'warning',
  DANGER: 'danger'
}

interface MdNode {
  type?: string
  value?: string
  children?: MdNode[]
  data?: Record<string, unknown>
}

function walkMd(node: MdNode, visit: (n: MdNode) => void): void {
  visit(node)
  if (node.children) {
    for (const c of node.children) walkMd(c, visit)
  }
}

/** 把 blockquote 首行 "[!KIND]" 语法解析为彩色告警块(注入 className,无新依赖) */
export function remarkCalloutPlugin(): (tree: unknown) => void {
  return (tree: unknown): void => {
    walkMd(tree as MdNode, (node) => {
      if (node.type !== 'blockquote') return
      const firstPara = node.children?.[0]
      if (!firstPara || firstPara.type !== 'paragraph' || !firstPara.children) return
      for (const child of firstPara.children) {
        if (child.type !== 'text' || typeof child.value !== 'string') continue
        const m = /^\[!(NOTE|TIP|IMPORTANT|WARNING|DANGER)\]\s*(.*)$/i.exec(child.value)
        if (!m) continue
        const kind = CALLOUT_KINDS[m[1].toUpperCase()]
        child.value = m[2] || ''
        const prevData = (node.data ?? {}) as Record<string, unknown>
        const prevProps = (prevData.hProperties ?? {}) as Record<string, unknown>
        node.data = {
          ...prevData,
          hProperties: {
            ...prevProps,
            className: `md-callout is-${kind}`
          }
        }
        if (child.value === '') {
          firstPara.children = firstPara.children.filter((x) => x !== child)
        }
        return
      }
      // "[!KIND]" 独占一段:移除空段落
      if (firstPara.children.length === 0 && node.children) {
        node.children = node.children.filter((x) => x !== firstPara)
      }
    })
  }
}

/** remark 插件清单(流式与终稿一致) */
export const MD_REMARK_PLUGINS = [remarkGfm, remarkCalloutPlugin]
