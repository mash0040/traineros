import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import './index.css'
import App from './App.tsx'

// BrowserRouter, not HashRouter: /verify?token= and /pause?token= are links pasted into
// emails, and one App Service serves the API and the SPA from the same origin, so real
// paths cost nothing and read like URLs a person can trust.
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
)
