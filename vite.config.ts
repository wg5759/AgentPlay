import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'
import path from 'path'

// 双端共享 Vite 配置：Electron 加载 dev server / 构建产物，Web 部署为 PWA
export default defineConfig({
  base: './',
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/**'],
      manifest: {
        name: 'AI播放器',
        short_name: 'AI播放器',
        description: '会动手的 AI 媒体中枢',
        theme_color: '#0a0a0a',
        background_color: '#0a0a0a',
        display: 'standalone',
        icons: []
      }
    })
  ],
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') }
  },
  server: { port: 5173 }
})
