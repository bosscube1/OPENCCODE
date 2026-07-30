import { StrictMode } from 'react'
import type { JSX } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { QuickEntry } from './components/QuickEntry'
import { LiveScreenAssistant } from './components/LiveScreenAssistant'
import { loadPrefs } from './lib/prefs'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Renderer bootstrap failed: #root is missing from index.html')
}

function pickRoute(): JSX.Element {
  const hash = window.location.hash
  // #/live renders the standalone Gemini Live copilot window with no <App/> underneath
  // it. Mounting <App/> here would re-run useStore.getState().init() in its boot effect,
  // spinning up a second SSE consumer and a second server supervisor. Never fold this
  // branch into <App/> — the copilot window must stay a separate, lighter renderer root.
  if (hash === '#/live') {
    // Theme is normally synced by an <App/> effect, which never runs on this
    // route — without this the copilot window ignores an explicit dark/light
    // choice and renders in the 'auto' palette next to a themed main window.
    applyStoredTheme()
    return <LiveScreenAssistant />
  }
  if (hash === '#/quick') return <QuickEntry />
  return <App />
}

/** Mirror of the theme effect in App.tsx, for renderer roots that skip <App/>. */
function applyStoredTheme(): void {
  const { theme } = loadPrefs()
  if (theme === 'auto') delete document.documentElement.dataset.theme
  else document.documentElement.dataset.theme = theme
}

createRoot(container).render(<StrictMode>{pickRoute()}</StrictMode>)
