import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { initTheme } from './ui/theme'
import '@fontsource-variable/inter/opsz.css'
import './ui/styles.css'
import './ui/experience.css'
import './ui/dashboard.css'
import './ui/proactive.css'
import './ui/b2c.css'
import App from './App.jsx'

initTheme()

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
