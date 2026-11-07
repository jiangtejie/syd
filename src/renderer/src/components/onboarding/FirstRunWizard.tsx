import { useState } from 'react'
import { FIRST_RUN_STEPS, firstRunState, type FirstRunState } from '../../../../shared/onboarding'
import { useWorkbenchStore } from '../../stores/workbench'
import { useAsyncEffect } from '../../lib/useAsyncEffect'

/**
 * 首启向导。
 *
 * 为什么需要：装完应用最硬的一步（64 位数据库密钥）**在应用外**，代码里明确写着「自动获取已停用」；
 * 而用户在应用内看到的只是一个空聊天框 + 一个只有「关于」的帮助菜单。首日流失就发生在这一屏。
 * 这里只做三件事：告诉他缺什么、把他送到正确的页面、允许他以后再弄。
 *
 * 判定逻辑在 shared/onboarding.ts（纯函数，有自检）：**只在确实缺东西时才弹** ——
 * 已经有账号又有密钥的用户不该被再教一遍，哪怕他从没点过向导。
 *
 * 视觉：与全站同一套面板语言（深色下是加光面板 + 霓虹进度块），样式见 pages/shell.css 的 .frw-*。
 */

const configApi = window.api?.cs?.config
const keyStoreApi = window.api?.cs?.keyStore

/** 进度块：01/02/03 + 短标签，完成的块亮起品牌色 */
function StepRail({ step }: { step: number }): React.JSX.Element {
  return (
    <div className="frw-steps" aria-hidden="true">
      {FIRST_RUN_STEPS.map((label, i) => (
        <div key={label} className={`frw-step${i + 1 <= step ? ' is-done' : ''}`}>
          <span className="frw-step-no">{String(i + 1).padStart(2, '0')}</span>
          <span className="frw-step-label">{label}</span>
        </div>
      ))}
    </div>
  )
}

export function FirstRunWizard(): React.JSX.Element | null {
  const setPage = useWorkbenchStore((s) => s.setPage)
  const [state, setState] = useState<FirstRunState | null>(null)
  const [busy, setBusy] = useState(false)

  useAsyncEffect(async () => {
    try {
      const cfg = (await configApi?.getAll?.().catch(() => null)) ?? {}
      if (String(cfg['onboarding.done'] ?? '') === '1') {
        setState(firstRunState({ done: true, accountCount: 0, keyCount: 0 }))
        return
      }
      const list = (await keyStoreApi?.list?.().catch(() => null)) ?? []
      const accounts = Array.isArray(list) ? list : []
      // status 为 null 表示这条账号连档案都没有；有 status 说明导入过密钥
      const keyCount = accounts.filter((a) => a && a.status !== null).length
      setState(firstRunState({ done: false, accountCount: accounts.length, keyCount }))
    } catch {
      setState(firstRunState({ done: true, accountCount: 0, keyCount: 0 }))
    }
  }, [])

  if (!state?.show) return null

  const dismiss = async (): Promise<void> => {
    setBusy(true)
    try {
      await configApi?.set?.('onboarding.done', '1')
    } catch {
      /* 写不进去也只是下次再弹一次，不拦着用户 */
    }
    setState({ ...state, show: false })
    setBusy(false)
  }

  return (
    <div className="frw-mask" role="presentation">
      <div className="frw-panel" role="dialog" aria-modal="true" aria-label={state.title}>
        <StepRail step={state.step} />
        <div className="frw-title">{state.title}</div>
        <div className="frw-detail">{state.detail}</div>
        <div className="frw-actions">
          <button type="button" className="ui-btn" disabled={busy} onClick={() => void dismiss()}>
            稍后再说
          </button>
          <button
            type="button"
            className="ui-btn is-primary"
            disabled={busy}
            onClick={() => {
              setPage('settings')
              void dismiss()
            }}
          >
            {state.action}
          </button>
        </div>
      </div>
    </div>
  )
}

export default FirstRunWizard
