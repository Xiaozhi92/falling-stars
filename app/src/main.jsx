import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Note: StrictMode disabled because react-globe.gl double-mounts and re-runs
// expensive WebGL init in dev, causing visible artifacts.
createRoot(document.getElementById('root')).render(<App />)
