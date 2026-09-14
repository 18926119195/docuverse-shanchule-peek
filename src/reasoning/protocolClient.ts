/**
 * Thin client for server-authoritative intrinsic-coordinate protocol.
 */
import { demoAuthHeaders } from './demoAuth'
import type { DialogueClosure, DirectionRecord } from './types'

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...demoAuthHeaders(),
    },
    body: JSON.stringify(body),
  })
  const rawText = await res.text()
  let data: unknown = null
  try {
    data = rawText ? (JSON.parse(rawText) as unknown) : null
  } catch {
    data = null
  }
  if (!res.ok) {
    const fromJson =
      typeof data === 'object' &&
      data !== null &&
      'error' in data &&
      typeof (data as { error: unknown }).error === 'string'
        ? (data as { error: string }).error
        : null
    if (fromJson) throw new Error(fromJson)
    if (res.status === 413) {
      throw new Error('页图过大，网关拒绝（未压缩；需提高函数体积极限或改直传）')
    }
    if (res.status === 504 || res.status === 524) {
      throw new Error('OCR 超时（该页上游过慢，请稍后重试同一原图）')
    }
    throw new Error(
      rawText.trim()
        ? `HTTP ${res.status}: ${rawText.slice(0, 160)}`
        : `HTTP ${res.status}`,
    )
  }
  if (data === null) {
    throw new Error(`空响应或非 JSON（HTTP ${res.status}）`)
  }
  return data as T
}

export interface ServerEmittedSlot {
  /** Opaque sealed bookKey（layout 坐标封印；never the raw lockId）. */
  handle: string
  label: string
  bbox: [number, number, number, number]
  /** 初始 OCR T（脸） */
  content: string
  sourceContent: string
  cutBound: true
  /** 页内 layout 步序 = bookKey 时间分量 */
  layoutK?: number
  /** @deprecated 同 layoutK */
  slotK?: number
  page?: number
}

export interface EmitPageResponse {
  ok: boolean
  docId: string
  page: number
  slots: ServerEmittedSlot[]
  markdown: string
  pageWidth?: number
  pageHeight?: number
  error?: string
}

/** Server cut→slot emission + sealed handles */
export async function protocolEmitPage(input: {
  docId: string
  page: number
  imageDataUri: string
}): Promise<EmitPageResponse> {
  return postJson<EmitPageResponse>('/api/protocol/emit-page', input)
}

/** Mint combo/fig/layout-slot bookKey handle (server seals doorplate). */
export async function protocolMintKey(
  input:
    | { kind: 'combo'; docId: string; memberHandles: string[] }
    | { kind: 'fig'; docId: string; figId: string }
    | {
        kind: 'slot'
        docId: string
        page: number
        /** layoutK；历史字段名 k */
        k?: number
        layoutK?: number
      },
): Promise<{ handle: string }> {
  const body =
    input.kind === 'slot'
      ? {
          kind: 'slot' as const,
          docId: input.docId,
          page: input.page,
          layoutK: input.layoutK ?? input.k,
          k: input.layoutK ?? input.k,
        }
      : input
  const data = await postJson<{ ok: boolean; handle: string }>(
    '/api/protocol/mint-key',
    body,
  )
  if (!data.handle) throw new Error('mint-key returned no handle')
  return { handle: data.handle }
}

type ClosureMap = Record<string, DialogueClosure>

function toServerClosures(map: ClosureMap): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, c] of Object.entries(map)) {
    out[k] = {
      key: c.key,
      excerpt: c.excerpt,
      memberKeys: c.memberKeys,
      directions: c.directions.map((d) => ({
        directionId: d.directionId,
        questionText: d.questionText,
        conclusion: d.conclusion,
        path: d.path,
        probe: d.probe,
        createdAt: d.createdAt,
        variants: d.variants,
      })),
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }
  }
  return out
}

function fromServerClosures(
  raw: Record<string, unknown>,
  prev: ClosureMap,
): ClosureMap {
  const out: ClosureMap = { ...prev }
  for (const [k, val] of Object.entries(raw)) {
    if (typeof val !== 'object' || val === null) continue
    const v = val as Record<string, unknown>
    const prevC = prev[k]
    const directionsRaw = Array.isArray(v.directions) ? v.directions : null
    const directions: DirectionRecord[] | undefined = directionsRaw
      ? directionsRaw
          .filter(
            (d): d is Record<string, unknown> =>
              typeof d === 'object' && d !== null,
          )
          .map((d) => ({
            directionId: String(d.directionId ?? ''),
            questionText: String(d.questionText ?? ''),
            conclusion: String(d.conclusion ?? ''),
            path: String(d.path ?? ''),
            probe: Array.isArray(d.probe)
              ? (d.probe as number[])
              : [],
            createdAt:
              typeof d.createdAt === 'number' ? d.createdAt : Date.now(),
            variants: Array.isArray(d.variants)
              ? d.variants.filter((x): x is string => typeof x === 'string')
              : [],
          }))
          .filter((d) => d.directionId)
      : undefined

    if (!prevC) {
      // Server created shell without client R — keep only if we somehow have R elsewhere
      continue
    }
    out[k] = {
      ...prevC,
      excerpt: typeof v.excerpt === 'string' ? v.excerpt : prevC.excerpt,
      memberKeys: Array.isArray(v.memberKeys)
        ? (v.memberKeys as string[])
        : prevC.memberKeys,
      directions: directions ?? prevC.directions,
      updatedAt: typeof v.updatedAt === 'number' ? v.updatedAt : prevC.updatedAt,
    }
  }
  return out
}

export async function protocolClosureEnsure(input: {
  closures: ClosureMap
  key: string
  excerpt: string
  memberKeys?: string[]
  R: DialogueClosure['R']
}): Promise<{ closures: ClosureMap; closure: DialogueClosure }> {
  const data = await postJson<{
    ok: boolean
    closures: Record<string, unknown>
    closure: { key: string; excerpt: string; memberKeys: string[] }
  }>('/api/protocol/closure', {
    action: 'ensure',
    closures: toServerClosures(input.closures),
    key: input.key,
    excerpt: input.excerpt,
    memberKeys: input.memberKeys,
  })
  const existing = input.closures[input.key]
  const closure: DialogueClosure = existing ?? {
    key: input.key,
    R: input.R,
    excerpt: input.excerpt,
    memberKeys: input.memberKeys ?? [input.key],
    directions: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  const merged = {
    ...input.closures,
    [input.key]: {
      ...closure,
      excerpt: data.closure.excerpt || closure.excerpt,
      memberKeys: data.closure.memberKeys?.length
        ? data.closure.memberKeys
        : closure.memberKeys,
    },
  }
  return {
    closures: fromServerClosures(data.closures, merged),
    closure: merged[input.key],
  }
}

export async function protocolClosureMatch(input: {
  closures: ClosureMap
  key: string
  question: string
}): Promise<{ hits: Array<{ directionId: string; score: number }> }> {
  const data = await postJson<{
    ok: boolean
    hits: Array<{ directionId: string; score: number }>
  }>('/api/protocol/closure', {
    action: 'match',
    closures: toServerClosures(input.closures),
    key: input.key,
    question: input.question,
  })
  return { hits: data.hits ?? [] }
}

export async function protocolClosureReuse(input: {
  closures: ClosureMap
  key: string
  directionId: string
}): Promise<
  | { reuse: true; path: string; conclusion: string }
  | { reuse: false }
> {
  const data = await postJson<{
    ok: boolean
    reuse: boolean
    path?: string
    conclusion?: string
  }>('/api/protocol/closure', {
    action: 'reuse',
    closures: toServerClosures(input.closures),
    key: input.key,
    directionId: input.directionId,
  })
  if (data.reuse && typeof data.path === 'string' && typeof data.conclusion === 'string') {
    return { reuse: true, path: data.path, conclusion: data.conclusion }
  }
  return { reuse: false }
}

export async function protocolClosureRemember(input: {
  closures: ClosureMap
  key: string
  questionText: string
  path: string
  conclusion: string
}): Promise<{ closures: ClosureMap; directionId: string }> {
  const data = await postJson<{
    ok: boolean
    closures: Record<string, unknown>
    directionId: string
  }>('/api/protocol/closure', {
    action: 'remember',
    closures: toServerClosures(input.closures),
    key: input.key,
    questionText: input.questionText,
    path: input.path,
    conclusion: input.conclusion,
  })
  return {
    closures: fromServerClosures(data.closures, input.closures),
    directionId: data.directionId,
  }
}
