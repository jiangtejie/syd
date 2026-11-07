import './assets/reset.css'
import './assets/main.css'
// 共享弹层/空态基元（.ui-modal/.ui-empty/.ui-spin 等）：全局引入，
// 避免懒加载页里用到它们时样式还没被 Modal/Feedback 的 chunk 带进来。

import './components/ui/ui.css'

import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
