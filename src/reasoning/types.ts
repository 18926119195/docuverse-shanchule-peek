/**
 * Interaction semantics for intrinsic-coordinate reasoning control.
 * Place lock bookKey = layout 槽门牌 (doc|slot|p|layoutK) 或 combo；
 * OCR/改字只动脸上的 T，不重铸门牌。page_norm AABB 是恢复几何。
 */

import type { FormalOp, FormalPathV1 } from './formalPath'
import type { SlotMemberRef } from './ocrSlot'

export type LinkType =
  | 'incremental'
  | 'refine'
  | 'contrast'
  | 'depend'
  | 'explore'
  | 'none'

export type RelationKind = 'overlap' | 'disjoint'
export type AdjustKind = 'expand' | 'shrink' | 'same' | 'partial'

export type AChunkSource =
  | 'ocr'
  | 'pdf_text'
  | 'page_text'
  | 'layout_fig'

/** Primary face that determines key* formula */
export type PlaceKind = 'text' | 'fig'

export interface TextFace {
  start: number
  end: number
  content: string
}

export interface FigFace {
  figId: string
  /** short machine readout / placeholder */
  note: string
  /** page image URL / data URI for audit or multimodal bundle */
  imageRef?: string
}

export interface PlaceFaces {
  text?: TextFace
  fig?: FigFace
}

export interface IntrinsicCoordinate {
  docId: string
  /** which face owns key* formula */
  kind: PlaceKind
  /**
   * Canonical bookKey handle（封印后）或 combo。
   * layout lockId 公式：`${docId}|slot|p${page}|k${layoutK}`（|slot|=历史词）
   * combo: `${docId}|combo|${hash(memberKeys)}`
   * legacy fig alias: `${docId}|fig|${figId}` (still accepted)
   */
  key: string
  /** stream alias offsets (audit / legacy); not the primary doorplate */
  start: number
  end: number
  figId?: string
  page: number
  /**
   * 页内 layout 步序（bookKey 时间分量）。
   * 字段名 slotK 为历史兼容；语义 = layoutK，≠ OCR 步。
   */
  slotK?: number
  /** 显式别名；有则应与 slotK 同值 */
  layoutK?: number
  /** member slot keys when this lock is a cross-slot combo */
  memberKeys?: string[]
  /** audit helpers: pct on each member T + parent AABB */
  members?: SlotMemberRef[]
  emphasisId: string
  chunkIds: string[]
  source: AChunkSource
  /** both faces may be present on one lock */
  faces: PlaceFaces
}

export interface DirectionRecord {
  directionId: string
  questionText: string
  probe: number[]
  path: string
  conclusion: string
  createdAt: number
  variants: string[]
  /** 本条路径真正挂靠的前提门牌（选定≡注入） */
  premiseKeys?: string[]
  /** 生成该路径的动作存档 ID 链 */
  actionIds?: string[]
  /** 用户是否采纳 */
  accepted?: boolean
  /**
   * 机读路径标记（少占上下文）：从本轮 path/conclusion 压成固定 schema，
   * 采纳后回流，供以后同模型秒懂。
   */
  pathMarker?: string
  /**
   * 工具×对象×步骤×模型 指纹（不含时间）。换模型 → 新指纹，不命中旧缓存。
   */
  fingerprint?: string
  /** accepted = 资产；inferred = 结论缓存（可未采纳复用） */
  cacheTier?: 'accepted' | 'inferred'
  /** @deprecated formal ops theater retired */
  formalOps?: FormalOp[]
  /** @deprecated formal ops theater retired */
  formalPath?: FormalPathV1
  /** 本路径引用的其它 pathId（reuse / 依赖） */
  referencedPathIds?: string[]
}

/** 工具网关一步存档：同一步输入/输出 + 前提名单 */
export type ActionKind =
  | 'retrieve'
  | 'compose'
  | 'infer'
  | 'accept'
  | 'reuse'
  | 'faultIn'
  | 'collapse'
  | 'scopeProbe'
  | 'peek'
  | 'supervise'

export interface ActionRecord {
  actionId: string
  actionKind: ActionKind
  /** 本步挂上的已有 key*（仅写信/网关注入/采纳步有意义；草稿步应为空） */
  premiseKeys: string[]
  /** 输入快照（问题、摘录、组合原料等） */
  inputsRef: {
    question?: string
    excerpt?: string
    lockKey?: string
    /** compose：进入组合的细槽门牌 */
    sourceKeys?: string[]
    /** draft | letter | gateway | accept | peek | supervise */
    role?: 'draft' | 'letter' | 'gateway' | 'accept' | 'reuse' | 'peek' | 'supervise'
    /** 采纳所针对的路径 */
    pathId?: string
    /** 复用所指向的已采纳路径 */
    reusedFromPathId?: string
    funnelStage?: string
    sectionIds?: string[]
    composeMode?: string
    usedGeometricFallback?: boolean
    key?: string
    approvedKeys?: string[]
    priorBriefHashes?: string[]
  }
  /** 输出快照（检索名单、组合单元、path/conclusion 等） */
  outputsRef: {
    candidateKeys?: string[]
    /** 草稿层别名（与 candidateKeys 相同，强调非注入） */
    draftKeys?: string[]
    /** compose：每个单元的配方 */
    units?: Array<{
      kind: string
      label: string
      unitKey: string
      memberKeys: string[]
    }>
    path?: string
    conclusion?: string
    error?: string
    roleNote?: string
    /** 采纳铸出的资产身份（directionId） */
    assetId?: string
    /** 复用：是否跳过了主模型 */
    reused?: boolean
    /** 采纳/推理：机读路径标记 */
    pathMarker?: string
    verdict?: string
    fails?: unknown[]
    decisionBrief?: string
    suggestAction?: string
    briefKey?: string
    /** @deprecated 用 briefKey */
    briefContentHash?: string
    briefRef?: string
    tone?: string
    summary?: string
    notes?: string[]
  }
  createdAt: number
}

/** 扇出可呈现的一条推理路径（含几何锚点） */
export interface FanoutSlotVisual {
  key: string
  page: number
  bbox: [number, number, number, number]
  excerpt: string
}

export type FanoutComposeScope = 'single' | 'same_page' | 'cross_page'

export interface FanoutPath {
  pathId: string
  question: string
  direction: DirectionRecord
  actionIds: string[]
  /** 前提所在页（与 R.page / strandIndex 同约定） */
  premisePages: number[]
  /** OCR/PDF 可视化用的成员槽（框 + 摘录） */
  slots: FanoutSlotVisual[]
  unitKind: 'fine' | 'cluster'
  unitLabel: string
  /** 组合范围：当前实现应为 single | same_page */
  composeScope: FanoutComposeScope
  /** 注入摘录（组合后读值） */
  injectedExcerpt: string
  /** 结论锚点在圈上的槽位角（弧度），用于箭头末端 */
  conclusionAngle: number
  createdAt: number
  /** 若本路径来自同槽组合的已采纳资产短路 */
  reusedFromPathId?: string
}

export interface DialogueClosure {
  key: string
  R: IntrinsicCoordinate
  excerpt: string
  /** Book/dialog closure = arrangement of slot keys (同构) */
  memberKeys: string[]
  directions: DirectionRecord[]
  createdAt: number
  updatedAt: number
}

export interface ReasonEdge {
  fromKey: string
  toKey: string
  relation: RelationKind
  adjust?: AdjustKind
  linkType: LinkType
  premiseConclusion?: string
  premisePath?: string
  forbidDirectionIds?: string[]
}

export interface InstructionBundle {
  R: IntrinsicCoordinate
  sourceExcerpt: string
  closureKey: string
  question: string
  forbidDirections: Array<{
    directionId: string
    questionSummary: string
    conclusionSummary: string
  }>
  edge?: ReasonEdge
  premise?: {
    conclusion: string
    pathSummary: string
    fromKey: string
  }
  policy: {
    mustGroundToExcerpt: true
    disallowOutsideR: true
  }
  meta: {
    mode: 'infer' | 'reuse'
    calledModel: boolean
    at: number
  }
}

export interface LlmCallResult {
  ok: boolean
  conclusion: string
  path: string
  raw?: string
  error?: string
  usedMock: boolean
}

export interface LockBox {
  page: number
  bbox: [number, number, number, number]
  /** 当前焦点槽（更粗/更亮）；路径其余引用框仍同时高亮 */
  focus?: boolean
}
