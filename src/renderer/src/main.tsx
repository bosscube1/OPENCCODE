import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App'
import { QuickEntry } from './components/QuickEntry'
import './index.css'

const container = document.getElementById('root')

if (!container) {
  throw new Error('Renderer bootstrap failed: #root is missing from index.html')
}

createRoot(container).render(
  <StrictMode>
    {window.location.hash === '#/quick' ? <QuickEntry /> : <App />}
  </StrictMode>
)
