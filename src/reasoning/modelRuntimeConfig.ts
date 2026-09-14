/**
 * Triple model deployment (project default stack):
 * - OCR: 智谱 glm-ocr（本地 Vite / Vercel `/api/zhipu` 代理 + ZHIPU_API_KEY）
 * - Chat: DeepSeek official（/api/llm → 服务端代理）
 * - Embedding: 已关闭（检索走 A1 + chat）
 * Runtime overrides in localStorage apply to OCR only while LLM stack is locked.
 */

export interface ModelSlotConfig {
  baseUrl: string
  apiKey: string
  model: string
}

export interface DualModelConfig {
  /** 版面/OCR → A1 文字脸与 figure 框 */
  ocr: ModelSlotConfig
  /** 审计 / V_q×V_book 寻址 */
  embed: ModelSlotConfig
  /** 推理 / InstructionBundle → 主模型 */
  reason: ModelSlotConfig
  /** 上传后是否允许自动 OCR（扫描件路径） */
  autoOcrOnUpload: boolean
  /**
   * 用户声明：PDF 自带可用文字层。
   * true → 上传跳过 OCR，用 pdf.js 文字；
   * false → 视为扫描件，有页图则 OCR（不因抽出少量字而跳过）。
   */
  pdfHasTextLayer: boolean
}

/** v3: 智谱 OCR + DeepSeek chat；embed 已关闭 */
const STORAGE_KEY = 'docuverse.models.v3'

/** Must match api/_lib/env.ts chat model. */
/** 全部推理 LLM 锁定 DeepSeek V4 Flash（API id；俗称 deepseekflash4） */
export const LOCKED_LLM = {
  baseUrl: '/api/llm',
  chatModel: 'deepseek-v4-flash',
} as const

function disabledEmbedSlot(): ModelSlotConfig {
  return { baseUrl: '', apiKey: '', model: '' }
}

function env(name: string): string {
  const v = import.meta.env[name]
  return typeof v === 'string' ? v.trim() : ''
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parseSlot(v: unknown, fallback: ModelSlotConfig): ModelSlotConfig {
  if (!isRecord(v)) return fallback
  // Empty localStorage fields fall back to env defaults (so .env.local applies).
  return {
    baseUrl:
      typeof v.baseUrl === 'string' && v.baseUrl.trim()
        ? v.baseUrl.trim()
        : fallback.baseUrl,
    apiKey:
      typeof v.apiKey === 'string' && v.apiKey.trim()
        ? v.apiKey.trim()
        : fallback.apiKey,
    model:
      typeof v.model === 'string' && v.model.trim()
        ? v.model.trim()
        : fallback.model,
  }
}

function lockedEmbedSlot(): ModelSlotConfig {
  return disabledEmbedSlot()
}

function lockedReasonSlot(): ModelSlotConfig {
  return {
    baseUrl: LOCKED_LLM.baseUrl,
    apiKey: '',
    model: LOCKED_LLM.chatModel,
  }
}

export function defaultDualModelConfig(): DualModelConfig {
  return {
    ocr: {
      baseUrl: env('VITE_OCR_BASE_URL') || '/api/zhipu',
      apiKey: env('VITE_OCR_API_KEY') || '',
      model: env('VITE_OCR_MODEL') || 'glm-ocr',
    },
    embed: lockedEmbedSlot(),
    reason: lockedReasonSlot(),
    autoOcrOnUpload: true,
    // 默认按扫描件：无可靠文字层 → 上传走 OCR
    pdfHasTextLayer: false,
  }
}

function migrateV1(_parsed: Record<string, unknown>): DualModelConfig {
  const fallback = defaultDualModelConfig()
  return {
    ocr: fallback.ocr,
    embed: lockedEmbedSlot(),
    reason: lockedReasonSlot(),
    autoOcrOnUpload: true,
    pdfHasTextLayer: false,
  }
}

export function loadDualModelConfig(): DualModelConfig {
  const fallback = defaultDualModelConfig()
  try {
    const rawV2 = localStorage.getItem(STORAGE_KEY)
    if (rawV2) {
      const parsed: unknown = JSON.parse(rawV2)
      if (!isRecord(parsed)) return fallback
      return {
        ocr: parseSlot(parsed.ocr, fallback.ocr),
        // Embed / reason temporarily locked server-side — ignore localStorage.
        embed: lockedEmbedSlot(),
        reason: lockedReasonSlot(),
        autoOcrOnUpload:
          typeof parsed.autoOcrOnUpload === 'boolean'
            ? parsed.autoOcrOnUpload
            : fallback.autoOcrOnUpload,
        pdfHasTextLayer:
          typeof parsed.pdfHasTextLayer === 'boolean'
            ? parsed.pdfHasTextLayer
            : fallback.pdfHasTextLayer,
      }
    }
    const rawV1 = localStorage.getItem('docuverse.models.v1')
    if (rawV1) {
      const parsed: unknown = JSON.parse(rawV1)
      if (isRecord(parsed)) return migrateV1(parsed)
    }
    return fallback
  } catch {
    return fallback
  }
}

export function saveDualModelConfig(cfg: DualModelConfig): void {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ocr: {
        baseUrl: cfg.ocr.baseUrl.trim(),
        apiKey: cfg.ocr.apiKey.trim(),
        model: cfg.ocr.model.trim(),
      },
      // Persist locked names for display continuity; server still enforces.
      embed: lockedEmbedSlot(),
      reason: lockedReasonSlot(),
      autoOcrOnUpload: cfg.autoOcrOnUpload,
      pdfHasTextLayer: cfg.pdfHasTextLayer,
    }),
  )
}

export function slotConfigured(slot: ModelSlotConfig): boolean {
  return slot.apiKey.trim().length > 0 && slot.model.trim().length > 0
}

/** OCR may use Vite proxy without browser key (server ZHIPU_API_KEY). */
export function ocrEndpointReady(slot: ModelSlotConfig): boolean {
  if (slot.model.trim().length === 0) return false
  if (slot.apiKey.trim().length > 0) return true
  const base = slot.baseUrl.trim()
  return base.startsWith('/api/zhipu') || base.length === 0
}

/** Embed via /api/llm proxy without browser key (server LLM_API_KEY). */
export function embedEndpointReady(slot: ModelSlotConfig): boolean {
  if (slot.model.trim().length === 0) return false
  if (slot.apiKey.trim().length > 0) return true
  const base = slot.baseUrl.trim()
  return base.startsWith('/api/llm') || base.length === 0
}

/** Reason via /api/protocol/infer (server assembles prompt + calls LLM). */
export function reasonEndpointReady(slot: ModelSlotConfig): boolean {
  if (slot.model.trim().length === 0) return false
  if (slot.apiKey.trim().length > 0) return true
  const base = slot.baseUrl.trim()
  return (
    base.startsWith('/api/llm') ||
    base.startsWith('/api/protocol') ||
    base.length === 0
  )
}

export function dualModelStatus(cfg: DualModelConfig = loadDualModelConfig()): {
  ocrReady: boolean
  embedReady: boolean
  reasonReady: boolean
  ocrModel: string
  embedModel: string
  reasonModel: string
  autoOcrOnUpload: boolean
  pdfHasTextLayer: boolean
} {
  return {
    ocrReady: ocrEndpointReady(cfg.ocr),
    embedReady: embedEndpointReady(cfg.embed),
    reasonReady: reasonEndpointReady(cfg.reason),
    ocrModel: cfg.ocr.model || '(未设)',
    embedModel: cfg.embed.model || '(未设)',
    reasonModel: cfg.reason.model || '(未设)',
    autoOcrOnUpload: cfg.autoOcrOnUpload,
    pdfHasTextLayer: cfg.pdfHasTextLayer,
  }
}
