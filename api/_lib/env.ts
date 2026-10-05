/**
 * Server-only env (Vercel Environment Variables / local process.env).
 * Chat: DeepSeek official API only (no embedding upstream).
 */

declare const process: { env: Record<string, string | undefined> }

const LOCKED_CHAT = {
  llmApiKey: 'sk-4c7c652154734aed8b37fe20816b7efd',
  llmBaseUrl: 'https://api.deepseek.com',
  chatModel: 'deepseek-v4-flash',
} as const

const LOCKED_OCR = {
  zhipuApiKey: 'ee855f9fa6344a728c5fdcd9b0c4d79d.Gu5bzsn8XtTgLzmM',
  ocrModel: 'glm-ocr',
} as const

export function serverEnv(name: string): string {
  const v = process.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

export function zhipuApiKey(): string {
  return serverEnv('ZHIPU_API_KEY') || LOCKED_OCR.zhipuApiKey
}

export function zhipuOcrModel(): string {
  return serverEnv('OCR_MODEL') || LOCKED_OCR.ocrModel
}

export function llmUpstream(): {
  baseUrl: string
  apiKey: string
  chatModel: string
} {
  return {
    baseUrl: LOCKED_CHAT.llmBaseUrl,
    apiKey: LOCKED_CHAT.llmApiKey,
    chatModel: LOCKED_CHAT.chatModel,
  }
}

export function demoAccessToken(): string {
  return serverEnv('DEMO_ACCESS_TOKEN')
}
