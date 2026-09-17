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
 */

const configApi = window.api?.cs?.config
const keyStoreApi = window.api?.cs?.keyStore

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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,.42)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 2000
      }}
    >
      <div
        style={{
          width: 480,
          maxWidth: '92vw',
          background: 'var(--bg-1, #fff)',
          color: 'var(--text-1, #222)',
          borderRadius: 10,
          padding: '20px 22px',
          boxShadow: '0 12px 40px rgba(0,0,0,.28)'
        }}
      >
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {FIRST_RUN_STEPS.map((label, i) => (
            <div
              key={label}
              style={{
                flex: 1,
                fontSize: 12,
                padding: '5px 0',
                textAlign: 'center',
                borderRadius: 5,
                background: i + 1 <= state.step ? 'var(--accent, #3b7ddd)' : 'var(--bg-2, #eee)',
                color: i + 1 <= state.step ? '#fff' : 'var(--text-3, #888)'
              }}
            >
              {i + 1}. {label}
            </div>
          ))}
        </div>

        <div style={{ fontSize: 16, fontWeight: 600, marginBottom: 8 }}>{state.title}</div>
        <div style={{ fontSize: 13, lineHeight: 1.75, color: 'var(--text-2, #555)' }}>
          {state.detail}
        </div>

        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 18 }}>
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
