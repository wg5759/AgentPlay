import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'

// The web build is a PWA, while the Electron build runs from file:// where a
// service worker cannot be registered. Register only in a served web context.
if (
  'serviceWorker' in navigator &&
  (window.location.protocol === 'http:' || window.location.protocol === 'https:')
) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register(new URL('./sw.js', document.baseURI))
  })
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
)
