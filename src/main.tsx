import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.tsx'
import { registerServiceWorker } from './lib/register-service-worker'
import './index.css'

const rootElement = document.getElementById('root')

if (!rootElement) {
  throw new Error(
    'RecoverEase failed to start: no #root element found in index.html.',
  )
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
)

// Installable app and offline page only; see public/sw.js.
registerServiceWorker()
