import { defineConfig, loadEnv, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { pdfJsWasmPlugin } from './server/pdfJsWasmPlugin.js'
import { viteProtocolApiPlugin } from './server/viteProtocolApiPlugin.js'

/** Match api/_lib/env.ts — DeepSeek official chat only. */
const LOCKED_CHAT = {
  llmApiKey: 'sk-4c7c652154734aed8b37fe20816b7efd',
  llmBaseUrl: 'https://api.deepseek.com',
  chatModel: 'deepseek-v4-flash',
} as const

const LOCKED_OCR = {
  zhipuApiKey: 'ee855f9fa6344a728c5fdcd9b0c4d79d.Gu5bzsn8XtTgLzmM',
} as const

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load parent workspace .env as well as local
  const rootEnv = loadEnv(mode, path.resolve(__dirname, '..'), '')
  const localEnv = loadEnv(mode, __dirname, '')
  const zhipuKey =
    localEnv.ZHIPU_API_KEY ||
    rootEnv.ZHIPU_API_KEY ||
    process.env.ZHIPU_API_KEY ||
    LOCKED_OCR.zhipuApiKey
  const chatKey = LOCKED_CHAT.llmApiKey
  const chatBase = LOCKED_CHAT.llmBaseUrl

  const config: UserConfig = {
    plugins: [react(), pdfJsWasmPlugin(__dirname), viteProtocolApiPlugin(__dirname, mode)],
    // Production: no sourcemaps → Sources 看不到 intrinsicKey.ts 等源文件名
    build: {
      sourcemap: false,
      minify: 'oxc',
      target: 'es2022',
      cssMinify: true,
      reportCompressedSize: false,
      chunkSizeWarningLimit: 1200,
    },
    server: {
      host: '127.0.0.1',
      // no-peek 实验：5175；main=5173；frontend-lab=5174
      port: 5175,
      strictPort: true,
      // chat-archive jsonl 常被其它进程锁住，监视会 EBUSY 把整服打崩
      watch: {
        ignored: [
          '**/docs/chat-archive/**',
          '**/聊天记录*/**',
          '**/agent-transcripts/**',
        ],
      },
      proxy: {
        '/api/zhipu': {
          target: 'https://open.bigmodel.cn',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/zhipu/, '/api/paas/v4'),
          configure: (proxy) => {
            // Never forward browser demo-token as upstream auth.
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${zhipuKey}`)
            })
          },
        },
        '/api/llm': {
          target: chatBase,
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/llm/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              proxyReq.setHeader('Authorization', `Bearer ${chatKey}`)
            })
          },
        },
      },
    },
  }
  return config
})
