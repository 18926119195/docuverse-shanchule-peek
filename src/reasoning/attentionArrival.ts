/**
 * LLM 自报「注意力是否到位」+ 输入 key 增量三态落台。
 * 三态不写入注意力窗 steps/edges，进 keyIncrementStatuses 供递送。
 */

import { extractJsonObject } from './inferPath'
import { useAttentionIo } from './attentionIoStore'
import {
  parseKeyIncrementStatuses,
  type StatusJob,
} from './keyIncrementStatus'

export type AttentionArrival =
  | { reported: true; arrived: boolean; source: 'llm' }
  | { reported: false; arrived: null; source: 'desk_monitor' }

/** 从任意 LLM JSON out 抽 attentionArrived / attentionReady */
export function parseAttentionArrival(llmText: string): AttentionArrival {
  const obj = extractJsonObject(llmText)
  if (!obj || typeof obj !== 'object') {
    return { reported: false, arrived: null, source: 'desk_monitor' }
  }
  const root = obj as Record<string, unknown>
  const raw =
    root.attentionArrived ??
    root.attentionReady ??
    root.wmReady ??
    root.attention_ok
  if (typeof raw === 'boolean') {
    return { reported: true, arrived: raw, source: 'llm' }
  }
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase()
    if (['true', 'yes', '到位', '已到', 'ok', '1'].includes(s)) {
      return { reported: true, arrived: true, source: 'llm' }
    }
    if (['false', 'no', '未到', '不到', '0'].includes(s)) {
      return { reported: true, arrived: false, source: 'llm' }
    }
  }
  return { reported: false, arrived: null, source: 'desk_monitor' }
}

/** 解析并写入写信台：本步输入 key 的 unread/sufficient/insufficient */
export function ingestKeyIncrementStatuses(input: {
  job: StatusJob
  llmText: string
  /** 窗内全部输入 key；LLM 未点名的默认 unread */
  windowKeys?: string[]
  /** 本问 queryKey；有则三态挂在该问线上，不串其它问 */
  queryKey?: string
}): number {
  const windowKeys = (input.windowKeys ?? [])
    .map((k) => k.trim())
    .filter(Boolean)
  // 落账前：本问本工种已是 unread 的窗内 key → 强制读完轮（禁止再记 unread）
  const forceCommit = new Set(
    useAttentionIo
      .getState()
      .listKeysUnread(input.job, { queryKey: input.queryKey })
      .filter((k) => windowKeys.includes(k)),
  )

  const parsed = parseKeyIncrementStatuses(input.llmText, input.job)
  const byKey = new Map(parsed.map((r) => [r.key, r]))
  if (windowKeys.length) {
    for (const key of windowKeys) {
      if (byKey.has(key)) continue
      byKey.set(
        key,
        forceCommit.has(key)
          ? {
              key,
              status: 'insufficient' as const,
              note: 'force-commit漏报→台记insufficient',
            }
          : { key, status: 'unread' as const },
      )
    }
  }

  const rows = [...byKey.values()].map((r) => {
    if (!forceCommit.has(r.key) || r.status !== 'unread') return r
    return {
      ...r,
      status: 'insufficient' as const,
      note:
        (r.note ? `${r.note} · ` : '') +
        'force-commit仍报unread→台记insufficient',
    }
  })
  if (rows.length === 0) return 0
  useAttentionIo.getState().recordKeyIncrementStatuses({
    job: input.job,
    queryKey: input.queryKey,
    rows,
  })
  return rows.length
}

/**
 * 台监：LLM 未自报 → 记台侧提示；自报未到位 → 写信台提示人。
 * 同时落 key 三态（若 JSON 有）。
 * 绝不写入 attention steps。
 * 不再用整窗 coverage 代理注意力。
 */
export function deskMonitorAttentionArrival(input: {
  job: string
  llmText: string
  windowKeys?: string[]
  /** 本问 queryKey；与 ingest 同挂问线 */
  queryKey?: string
}): AttentionArrival {
  const statusJob = input.job as StatusJob
  const n = ingestKeyIncrementStatuses({
    job: statusJob,
    llmText: input.llmText,
    windowKeys: input.windowKeys,
    queryKey: input.queryKey,
  })

  const parsed = parseAttentionArrival(input.llmText)
  const io = useAttentionIo.getState()

  if (parsed.reported) {
    if (!parsed.arrived) {
      io.setDeskPrompt(
        `写信台 · ${input.job} LLM 自报注意力未到位（attentionArrived=false）。请检查本窗材料或重跑。`,
      )
      io.pushIntentDeskLog({
        question: '',
        action: 'attention_not_arrived',
        note:
          `${input.job} · llm self-report false` +
          (n ? ` · key三态×${n}` : ''),
      })
    }
    return parsed
  }

  const note =
    `${input.job} · 未自报注意力；台仅记监、不挡下游` +
    (n ? ` · key三态×${n}` : '')

  io.pushIntentDeskLog({
    question: '',
    action: 'desk_monitor_attention',
    note,
  })

  return {
    reported: false,
    arrived: null,
    source: 'desk_monitor',
  }
}
