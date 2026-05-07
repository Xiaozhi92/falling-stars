import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
//
// GitHub Pages base path. When deploying to https://<user>.github.io/falling-stars/
// the build needs `/falling-stars/` as the URL prefix. Override via env if the
// repo is renamed: `VITE_BASE=/other-name/ npm run build`.
const BASE = process.env.VITE_BASE || '/falling-stars/'

export default defineConfig(({ command }) => ({
  base: command === 'build' ? BASE : '/',
  plugins: [react()],
}))
