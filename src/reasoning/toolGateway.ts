/**
 * Tool gateway: retrieve / compose / infer / reuse ActionRecord 出口。
 * 草稿召回（FanoutHud 遗留）：全书 BM25，无 LLM 选廊/选门、无漏斗。
 * 主路径 inject 由写信配方 + 网关 infer-ops 登记。
 */

import type { FanoutInferUnit } from './fanoutCompose'
import { FANOUT_ROLE_NOTE } from './fanoutRoles'
import { demoAuthHeaders } from './demoAuth'
import type { AbBlock } from './formalPath'
import { gateReturnSubset } from './hardGates'
import type { BookIndex, CircleCandidate } from './pipelineA'
import { recallCandidatesByBm25 } from './retrieveBm25'
import type { BookSemanticIndex } from './semanticIndex'
import type {
  ActionRecord,
  DirectionRecord,
  FanoutPath,
} from './types'
import { executeInstructionCompose } from './instructionCompose'
import { proposeComposeBags } from './motionBrain'

function newActionId(kind: string): string {
  return `${kind}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

/** Stable bag identity (sorted keys). Doorplates contain `|`, so join with `\0`. */
export function memberKeysSignature(keys: string[]): string {
  return [...keys].filter(Boolean).sort().join('\0')
}

export interface GatewayRetrieveResult {
  action: ActionRecord
  candidates: CircleCandidate[]
  searchQuery: string
  poolSize: number
  autoLockOk: boolean
  expandNote: string
}

export interface GatewayComposeResult {
  action: ActionRecord
  units: FanoutInferUnit[]
  ok: boolean
  error?: string
}

export interface GatewayInferResult {
  action: ActionRecord
  direction: DirectionRecord | null
  ok: boolean
  error?: string
  usedKeys?: string[]
}

type InferOpsWireResponse = {
  ok?: boolean
  error?: string
  conclusion?: string
  path?: string
  usedKeys?: string[]
}

/**
 * @deprecated 非主架构路径。Fanout 草稿用；正式问答请走 autoFlow / 写信台。
 * 检索漏斗已删除；仅全书 BM25。
 */
export async function executeRetrieve(input: {
  bookIndex: BookIndex
  question: string
  topK?: number
  semanticIndex?: BookSemanticIndex | null
  forceWholeBook?: boolean
  preferredSectionIds?: ReadonlyArray<string>
}): Promise<
  GatewayRetrieveResult & {
    stage?: string
    sectionIds?: string[]
    lockCorridorHint?: string
  }
> {
  void input.semanticIndex
  void input.forceWholeBook
  void input.preferredSectionIds
  const question = input.question.trim()
  const topK = input.topK ?? 5
  const bm = await recallCandidatesByBm25({
    bookIndex: input.bookIndex,
    query: question,
    topK,
    allowedKeys: null,
  })
  const draftKeys = bm.candidates.map((c) => c.R.key)
  const action: ActionRecord = {
    actionId: newActionId('retrieve'),
    actionKind: 'retrieve',
    premiseKeys: [],
    inputsRef: {
      question,
      role: 'draft',
      funnelStage: 'removed',
    },
    outputsRef: {
      candidateKeys: draftKeys,
      draftKeys,
      roleNote: [FANOUT_ROLE_NOTE.draft, 'BM25草稿（漏斗已废）· 检索漏斗已删除；仅 BM25 草稿']
        .filter(Boolean)
        .join(' · '),
    },
    createdAt: Date.now(),
  }
  return {
    action,
    candidates: bm.candidates,
    searchQuery: question,
    poolSize: bm.poolSize,
    autoLockOk: bm.autoLockOk,
    expandNote: '检索漏斗已删除 · 全书BM25草稿',
    stage: 'bm25_draft_only',
    sectionIds: [],
  }
}

/**
 * 写信组合：运动脑提议袋 → 指令组袋。
 */
export async function executeCompose(input: {
  bookIndex: BookIndex
  fineCandidates: CircleCandidate[]
  question?: string
}): Promise<GatewayComposeResult> {
  const draftKeys = input.fineCandidates.map((c) => c.R.key)
  const bags = proposeComposeBags({
    draftKeys,
    bookIndex: input.bookIndex,
    semantic: null,
    maxBags: Math.min(5, Math.max(1, draftKeys.length)),
  })
  const composed = await executeInstructionCompose({
    bookIndex: input.bookIndex,
    fineCandidates: input.fineCandidates,
    draftKeys,
    question: input.question,
    spec: {
      mode: 'custom',
      customBags: bags.bags,
      maxBags: Math.max(1, bags.bags.length),
    },
  })
  return {
    action: composed.action,
    units: composed.units,
    ok: composed.ok,
    error: composed.error,
  }
}

/**
 * 网关 infer：编译器 blocks → /api/protocol/infer-ops → 结论 + usedKeys。
 */
export async function executeInferOps(input: {
  question: string
  blocks: AbBlock[]
  unitLabel?: string
  premiseKeys: string[]
}): Promise<GatewayInferResult & { usedKeys?: string[] }> {
  const question = input.question.trim()
  const premiseKeys = input.premiseKeys.filter(Boolean)
  const blocks = input.blocks.filter((b) => b.key && b.text.trim())

  if (blocks.length === 0) {
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: { question, role: 'gateway' },
      outputsRef: {
        error: '编译后 blocks 为空',
        roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer`,
      },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: '编译后 blocks 为空' }
  }

  let data: InferOpsWireResponse | null = null
  let fetchError: string | undefined

  try {
    const res = await fetch('/api/protocol/infer-ops', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...demoAuthHeaders(),
      },
      body: JSON.stringify({
        question,
        blocks,
        unitLabel: input.unitLabel,
      }),
    })
    data = (await res.json().catch(() => null)) as InferOpsWireResponse | null
    if (!res.ok) {
      fetchError =
        data && typeof data.error === 'string'
          ? data.error
          : `HTTP ${res.status}`
    }
  } catch (e) {
    fetchError = e instanceof Error ? e.message : String(e)
  }

  if (fetchError || !data || data.ok === false) {
    const err = fetchError ?? data?.error ?? 'infer 失败'
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: {
        question,
        excerpt: blocks.map((b) => b.key).join(', '),
        role: 'gateway',
      },
      outputsRef: { error: err, roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer` },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: err }
  }

  const conclusion = (data.conclusion ?? '').trim()
  const pathText = (data.path ?? '').trim()
  const usedKeys = (data.usedKeys ?? []).filter(
    (k): k is string => typeof k === 'string' && Boolean(k),
  )

  if (!conclusion && !pathText) {
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: { question, role: 'gateway' },
      outputsRef: {
        error: 'infer 无结论',
        roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer`,
      },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: 'infer 无结论' }
  }

  const returned = usedKeys.length > 0 ? usedKeys : premiseKeys
  const g2 = gateReturnSubset(premiseKeys, returned)
  if (!g2.ok) {
    const msg = g2.fails[0]?.message ?? 'G2 回引不在递交集'
    const action: ActionRecord = {
      actionId: newActionId('infer'),
      actionKind: 'infer',
      premiseKeys,
      inputsRef: {
        question,
        excerpt: blocks
          .map((b) => `${b.key}:${b.text.slice(0, 48)}`)
          .join(' | '),
        role: 'gateway',
      },
      outputsRef: {
        error: msg,
        path: pathText,
        conclusion,
        roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer · ${msg}`,
      },
      createdAt: Date.now(),
    }
    return { action, direction: null, ok: false, error: msg, usedKeys: returned }
  }

  const action: ActionRecord = {
    actionId: newActionId('infer'),
    actionKind: 'infer',
    premiseKeys,
    inputsRef: {
      question,
      excerpt: blocks
        .map((b) => `${b.key}:${b.text.slice(0, 48)}`)
        .join(' | '),
      role: 'gateway',
    },
    outputsRef: {
      path: pathText,
      conclusion,
      roleNote: `${FANOUT_ROLE_NOTE.gateway} · infer · G2 ok`,
    },
    createdAt: Date.now(),
  }

  const direction: DirectionRecord = {
    directionId: `dir_${action.actionId}`,
    questionText: question,
    probe: [],
    path: pathText,
    conclusion,
    createdAt: Date.now(),
    variants: [],
    premiseKeys,
    actionIds: [action.actionId],
    accepted: undefined,
  }

  return {
    action,
    direction,
    ok: true,
    usedKeys: returned,
  }
}

/**
 * 复用：同槽组合已有路径 → 网关短路（Fanout 遗留；主架构 reuse 走 neighbour→path）。
 */
export function executeReuse(input: {
  candidate: CircleCandidate
  question: string
  fromPath: FanoutPath
}): GatewayInferResult {
  const question = input.question.trim()
  const prev = input.fromPath.direction
  const premiseKeys =
    prev.premiseKeys && prev.premiseKeys.length > 0
      ? [...prev.premiseKeys]
      : input.candidate.R.memberKeys && input.candidate.R.memberKeys.length > 0
        ? [...input.candidate.R.memberKeys]
        : [input.candidate.R.key]

  const action: ActionRecord = {
    actionId: newActionId('reuse'),
    actionKind: 'reuse',
    premiseKeys,
    inputsRef: {
      question,
      excerpt: input.candidate.excerpt.slice(0, 240),
      role: 'reuse',
      reusedFromPathId: input.fromPath.pathId,
      pathId: input.fromPath.pathId,
    },
    outputsRef: {
      path: prev.path,
      conclusion: prev.conclusion,
      reused: true,
      pathMarker: prev.pathMarker,
      roleNote: FANOUT_ROLE_NOTE.reuse,
    },
    createdAt: Date.now(),
  }

  const direction: DirectionRecord = {
    directionId: `dir_${action.actionId}`,
    questionText: question,
    probe: [...(prev.probe ?? [])],
    path: prev.path,
    conclusion: prev.conclusion,
    createdAt: Date.now(),
    variants: [...(prev.variants ?? [])],
    premiseKeys,
    actionIds: [action.actionId],
    referencedPathIds: [
      input.fromPath.pathId,
      ...(prev.referencedPathIds ?? []),
    ],
    pathMarker: prev.pathMarker,
    fingerprint: prev.fingerprint,
    accepted: undefined,
  }

  return { action, direction, ok: true }
}
