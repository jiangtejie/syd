import type { ElectronAPI } from '@electron-toolkit/preload'
import type { PreloadApi } from '../shared/api'

/**
 * 渲染端 window.api 声明(仅声明,实体在 src/preload/index.ts)。
 * 桥接口的真源见 src/shared/api.ts —— 这里不再重复维护方法签名。
 */
declare global {
  interface Window {
    electron: ElectronAPI
    api: PreloadApi
  }
}
