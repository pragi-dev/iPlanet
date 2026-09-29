import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './ui/styles.css'
import './ui/experience.css'
import './ui/dashboard.css'
import App from './App.jsx'

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
