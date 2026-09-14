import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { ensurePdfRuntimePolyfills } from './data/pdfPolyfills'
import App from './App.tsx'
import './index.css'

ensurePdfRuntimePolyfills()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
