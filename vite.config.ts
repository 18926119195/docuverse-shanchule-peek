import { defineConfig, loadEnv, type ProxyOptions, type UserConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { llmUpstream } from './api/_lib/env.js'
import path from 'node:path'
import { pdfJsWasmPlugin } from './server/pdfJsWasmPlugin.js'
import { viteProtocolApiPlugin } from './server/viteProtocolApiPlugin.js'

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  // Load parent workspace .env as well as local
  const rootEnv = loadEnv(mode, path.resolve(import.meta.dirname, '..'), '')
  const localEnv = loadEnv(mode, import.meta.dirname, '')
  const zhipuKey = (localEnv.ZHIPU_API_KEY || rootEnv.ZHIPU_API_KEY || '').trim()
  const chatKey = (localEnv.LLM_API_KEY || rootEnv.LLM_API_KEY || '').trim()
  const proxy: Record<string, ProxyOptions> = {}

  if (zhipuKey) {
    proxy['/api/zhipu'] = {
      target: 'https://open.bigmodel.cn',
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/zhipu/, '/api/paas/v4'),
      configure: (proxy) => {
        // Never forward browser demo-token as upstream auth.
        proxy.on('proxyReq', (proxyReq) => {
          proxyReq.setHeader('Authorization', `Bearer ${zhipuKey}`)
        })
      },
    }
  }

  if (chatKey) {
    proxy['/api/llm'] = {
      target: llmUpstream().baseUrl,
      changeOrigin: true,
      rewrite: (p) => p.replace(/^\/api\/llm/, ''),
      configure: (proxy) => {
        proxy.on('proxyReq', (proxyReq) => {
          proxyReq.setHeader('Authorization', `Bearer ${chatKey}`)
        })
      },
    }
  }

  const config: UserConfig = {
    plugins: [react(), pdfJsWasmPlugin(import.meta.dirname), viteProtocolApiPlugin(import.meta.dirname, mode)],
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
      proxy,
    },
  }
  return config
})
