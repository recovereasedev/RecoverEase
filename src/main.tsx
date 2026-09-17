import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './app/App.tsx'
import { installPromptStore } from './lib/pwa-install'
import { registerServiceWorker } from './lib/register-service-worker'
import './index.css'

// Before the first render: Chrome offers its install event once, early,
// and RecoverEase asks for it later, from its own popup. See
// src/lib/pwa-install.ts.
installPromptStore.start()

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
