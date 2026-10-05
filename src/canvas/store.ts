import { create } from 'zustand'
import * as THREE from 'three'
import type { PageDocument, ResolvedConnection } from '../zigzag/types'
import { buildPdfPageUniverse } from '../data/pdfUniverse'
import {
  buildConstructionTriangle,
  constructionFaceOnPose,
  constructionPoseForStage,
  migrateLinksSphericalComment,
  triangleForLink,
  type ConstructionDepth,
  type ConstructionStage,
  type ConstructionTriangle,
} from './constructionCamera'
import {
  anchoredTetrahedronProjectionPose,
  buildAnchoredTetrahedron,
  buildEmphasisTetrahedron,
  countEmphasesOnFace,
  pickCandidateD,
  tetrahedronCornerPose,
  type TetCorner,
} from './emphasisTetrahedron'
import { PAGE_H, PAGE_W, clampApexToInterlayer, defaultApexBetweenHomes, innerSphereRadius, pageHomePosition, pageRadialDirection, radialToYawPitch, readingOuterRadius, yawPitchToRadial } from './geometry'
import {
  bondsStorageKey,
  clearAllBondStorage,
  loadBondState,
  newBeamId,
  newBondId,
  saveBondState,
  type PermanentBond,
  type UserBeam,
} from '../data/bonds'
import {
  appendDrawPoint,
  clearAllEmphasisStorage,
  emphasisStorageKey,
  loadEmphasisState,
  localToPagePoint,
  makeRegionSelector,
  newEmphasisId,
  newEmphasisLinkId,
  newPipelineStepId,
  resolveClosedEmphasisRing,
  saveEmphasisState,
  type EmphasisEdge,
  type EmphasisLink,
  type PagePoint,
  type PipelineStep,
} from '../data/emphasis'
import {
  appendKeyframe,
  sampleViewPath,
  type ViewKeyframe,
  type ViewKeyframeTag,
  type ViewPathMode,
} from '../data/viewPath'
import {
  buildDefaultAiLinkProposal,
  sleep,
  type AiEmphasisProposal,
} from '../data/aiEmphasisDemo'
import {
  imageUrlToDataUri,
  localPointToBbox,
  newOcrBlockId,
  ocrPageHasEdits,
  rebuildOcrMarkdown,
  type OcrBlock,
  type OcrPageResult,
} from '../data/ocrService'
import {
  hasPageImageInVault,
  stashPageImageDataUri,
} from '../data/pageImageVault'
import { emitPageViaProtocol } from '../reasoning/emitClient'
import { useIndexGate } from '../reasoning/indexGate'
import type { FlinkType } from '../zigzag/types'

export type CorpusId = 'pdf' | 'origins' | 'upload'

function indexDocIdFromStore(state: {
  corpus: CorpusId
  uploadLabel: string | null
}): string {
  if (state.corpus === 'upload' && state.uploadLabel) {
    return `upload:${state.uploadLabel}`
  }
  return `corpus:${state.corpus}`
}

/** Push OCR / T changes into gated bookIndex (page-level or atom T). */
async function syncIndexPages(pageIndices: number[]): Promise<void> {
  const unique = [...new Set(pageIndices)].filter((p) => p >= 0)
  if (unique.length === 0) return
  const state = useDocuverse.getState()
  await useIndexGate.getState().syncPages({
    docId: indexDocIdFromStore(state),
    pages: state.pages,
    ocrByStrand: state.ocrByStrand,
    pageIndices: unique,
  })
}

async function syncIndexAtomText(
  atomKey: string,
  content: string,
  pageIndex: number,
): Promise<void> {
  const gate = useIndexGate.getState()
  const patched = await gate.syncAtomText({ atomKey, content })
  if (patched) return
  // Atom not in index yet (OCR after finalize, or failed earlier) → page rebuild
  await syncIndexPages([pageIndex])
}

const emptyBuilt = { pages: [] as PageDocument[], connections: [] as ResolvedConnection[] }
const pdfBuilt = buildPdfPageUniverse()

let uploadedBuilt: {
  pages: PageDocument[]
  connections: ResolvedConnection[]
  label: string
} | null = null

function pack(corpus: CorpusId): {
  pages: PageDocument[]
  connections: ResolvedConnection[]
} {
  if (corpus === 'upload' && uploadedBuilt) return uploadedBuilt
  // pdf / origins demos removed — empty workspace until upload
  void corpus
  void pdfBuilt
  return emptyBuilt
}

function revokeBlobPages(pages: PageDocument[]): void {
  for (const p of pages) {
    if (p.imageUrl?.startsWith('blob:')) {
      URL.revokeObjectURL(p.imageUrl)
    }
  }
}

function connectionsForStrand(
  all: ResolvedConnection[],
  strand: number,
): ResolvedConnection[] {
  return all
    .filter((c) => c.fromStrand === strand || c.toStrand === strand)
    .sort((a, b) => {
      const ao = a.fromStrand === strand ? a.fromPageOffset : a.toPageOffset
      const bo = b.fromStrand === strand ? b.fromPageOffset : b.toPageOffset
      return ao - bo
    })
}

function companionOf(conn: ResolvedConnection, current: number): number {
  return conn.fromStrand === current ? conn.toStrand : conn.fromStrand
}

function beamsToConnections(
  bonds: PermanentBond[],
  beams: UserBeam[],
): ResolvedConnection[] {
  const byId = new Map(bonds.map((b) => [b.id, b]))
  const out: ResolvedConnection[] = []
  for (const beam of beams) {
    const from = byId.get(beam.fromBondId)
    const to = byId.get(beam.toBondId)
    if (!from || !to) continue
    out.push({
      id: beam.id,
      kind: 'flink',
      flinkType: beam.flinkType,
      fromStrand: from.strandIndex,
      toStrand: to.strandIndex,
      fromStart: 0,
      fromSize: 1,
      toStart: 0,
      toSize: 1,
      fromPageOffset: 0,
      toPageOffset: 0,
      fromBbox: from.bbox,
      toBbox: to.bbox,
      comment: [from.comment, to.comment].filter(Boolean).join(' · ').slice(0, 200),
    })
  }
  return out
}

function hydrateBonds(
  corpus: CorpusId,
  label: string | null,
): {
  bonds: PermanentBond[]
  beams: UserBeam[]
  connections: ResolvedConnection[]
} {
  const { bonds, beams } = loadBondState(bondsStorageKey(corpus, label))
  return { bonds, beams, connections: beamsToConnections(bonds, beams) }
}

function hydrateEmphasis(
  corpus: CorpusId,
  label: string | null,
  pageCount: number,
): {
  edges: EmphasisEdge[]
  links: EmphasisLink[]
  pipeline: PipelineStep[]
} {
  const raw = loadEmphasisState(emphasisStorageKey(corpus, label))
  const docId =
    corpus === 'upload' && label
      ? `upload:${label}`
      : `corpus:${corpus}`
  const edges = raw.edges.map((e) =>
    e.docId ? e : { ...e, docId },
  )
  const links = migrateLinksSphericalComment(
    edges,
    raw.links,
    Math.max(pageCount, 1),
  )
  if (links !== raw.links || edges.some((e, i) => e !== raw.edges[i])) {
    saveEmphasisState(
      emphasisStorageKey(corpus, label),
      edges,
      links,
      raw.pipeline,
    )
  }
  // 恢复人手划重点到共享基底（与 layout peer）
  void import('../reasoning/pageMarkStore').then(({ usePageMarkStore }) => {
    const st = usePageMarkStore.getState()
    for (const e of edges) {
      st.upsertEmphasizeMark({
        markId: e.id,
        docId: e.docId ?? docId,
        page: e.strandIndex,
        aabb: e.region.aabb,
        polygon: e.region.polygon,
        createdAt: e.createdAt,
      })
    }
  })
  return { edges, links, pipeline: raw.pipeline }
}

function persistEmphasis(get: () => DocuverseState): void {
  const { corpus, uploadLabel, emphasisEdges, emphasisLinks, pipelineSteps } =
    get()
  saveEmphasisState(
    emphasisStorageKey(corpus, uploadLabel),
    emphasisEdges,
    emphasisLinks,
    pipelineSteps,
  )
}

function pushPipeline(
  get: () => DocuverseState,
  set: (partial: Partial<DocuverseState>) => void,
  step: Omit<PipelineStep, 'id' | 'at'> & { id?: string; at?: number },
): void {
  const next: PipelineStep = {
    id: step.id ?? newPipelineStepId(),
    at: step.at ?? Date.now(),
    kind: step.kind,
    actor: step.actor,
    summary: step.summary,
    detail: step.detail,
  }
  const pipelineSteps = [...get().pipelineSteps, next].slice(-200)
  set({ pipelineSteps })
  persistEmphasis(get)
}

function applyBondGraph(
  set: (
    partial:
      | Partial<DocuverseState>
      | ((s: DocuverseState) => Partial<DocuverseState>),
  ) => void,
  get: () => DocuverseState,
  bonds: PermanentBond[],
  beams: UserBeam[],
  extras?: Partial<DocuverseState>,
): void {
  const { currentStrand, currentConnectionId, corpus, uploadLabel } = get()
  const connections = beamsToConnections(bonds, beams)
  const list = connectionsForStrand(connections, currentStrand)
  let cursor = list.findIndex((c) => c.id === currentConnectionId)
  if (cursor < 0) cursor = 0
  const cur = list[cursor]
  saveBondState(bondsStorageKey(corpus, uploadLabel), bonds, beams)
  set({
    permanentBonds: bonds,
    userBeams: beams,
    connections,
    connectionsOnCurrent: list,
    connectionCursor: cursor,
    currentConnectionId: cur?.id ?? null,
    companionStrand: cur
      ? companionOf(cur, currentStrand)
      : get().companionStrand,
    ...extras,
  })
}

function triggerSwoop(
  set: (partial: Partial<DocuverseState>) => void,
  get: () => DocuverseState,
  strand?: number,
): void {
  const s = get()
  const total = Math.max(s.pages.length, 1)
  const target = strand ?? s.currentStrand
  const { yaw, pitch } = radialToYawPitch(pageRadialDirection(target, total))
  set({
    swooping: true,
    viewYaw: yaw,
    viewPitch: pitch,
    viewPan: [0, 0, 0],
    cameraDistance: readingOuterRadius(total),
  })
  setTimeout(() => set({ swooping: false }), 1100)
}

/** Outer-shell radius so both ends of a cross-page beam fit in view */
function framingDistanceForPair(
  strandA: number,
  strandB: number,
  total: number,
  fallback: number,
): number {
  const a = pageHomePosition(strandA, Math.max(total, 1))
  const b = pageHomePosition(strandB, Math.max(total, 1))
  const sep = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
  const inner = innerSphereRadius(Math.max(total, 1))
  if (sep < 12) return Math.max(fallback, readingOuterRadius(total))
  return Math.min(inner * 3.5, Math.max(readingOuterRadius(total), inner + sep * 0.55))
}

const initialBonds = hydrateBonds('upload', null)
const initialEmphasis = hydrateEmphasis('upload', null, 0)
const initial = {
  pages: [] as PageDocument[],
  connections: initialBonds.connections,
}
const initialOnCurrent = connectionsForStrand(initial.connections, 0)
const initialConn = initialOnCurrent[0] ?? null

interface DocuverseState {
  corpus: CorpusId
  uploadLabel: string | null
  uploadProgress: { current: number; total: number; message: string } | null
  pages: PageDocument[]
  connections: ResolvedConnection[]
  currentStrand: number
  companionStrand: number
  currentConnectionId: string | null
  connectionsOnCurrent: ResolvedConnection[]
  connectionCursor: number
  cameraDistance: number
  viewYaw: number
  viewPitch: number
  /** Extra look-target offset — fly-through / free travel past street ends */
  viewPan: [number, number, number]
  swooping: boolean
  ocrOpen: boolean
  ocrBusy: boolean
  ocrError: string | null
  ocrActiveStrand: number | null
  ocrByStrand: Record<number, OcrPageResult>
  /** Hovered / selected block id (stable) */
  ocrHoverBlock: string | null
  ocrEditingBlockId: string | null
  /** True when editing via double-click on the OCR twin plane */
  ocrInlineEdit: boolean
  /** Permanent PDF-slice ↔ confirmed-OCR ↔ comment bonds */
  permanentBonds: PermanentBond[]
  /** User-authored rays between bonds */
  userBeams: UserBeam[]
  /** Bond selected as ray endpoint A */
  bondLinkFromId: string | null
  /** Emphasis edges (figure←ground on page) — no content copies */
  emphasisEdges: EmphasisEdge[]
  /** Cross-emphasis (often cross-page) user rays */
  emphasisLinks: EmphasisLink[]
  /** Conversion pipeline ledger */
  pipelineSteps: PipelineStep[]
  /** Draw closed region on current page */
  emphasizeMode: boolean
  /** True while left button stroke is in progress */
  emphasisStrokeActive: boolean
  emphasisDraftPoints: PagePoint[]
  /** Which page proxy currently owns the live draft ink (same edge store). */
  emphasisDraftStrand: number | null
  selectedEmphasisId: string | null
  /** Link endpoint A for cross-page emphasis ray */
  emphasisLinkFromId: string | null
  /** After seal, nudge user to optionally write reading */
  promptReadingForId: string | null
  /** Spacebar floating workbench (强调 / 射线 / Agent) */
  workbenchOpen: boolean
  workbenchTab: 'emphasis' | 'beams' | 'agent'
  /**
   * 星图·建联面板可见性。与强调笔绑定（Space+G 同开通关）；
   * 构建/回溯镜里并与评论层同步。
   */
  starMapOpen: boolean
  /** Overview board: Agent hits (or all edges) laid out for visual linking */
  overviewOpen: boolean
  overviewIds: string[]
  /** Last Agent hit ids — overview filter「Agent 结果」 */
  lastAgentHitIds: string[]
  /** Agent demo: currently drawing / linking on the user's behalf */
  aiDemoRunning: boolean
  /** Status line for Agent propose demo */
  aiDemoStatus: string | null
  /**
   * Selected purple emphasis-link focus stage:
   * extract the two connected pages from original render and present them.
   */
  linkFocusId: string | null
  /** Which endpoint is "main" in the focus stage (Nelson current) */
  linkFocusMainIsFrom: boolean
  /** Purple-link apex currently being dragged */
  draggingLinkId: string | null
  /**
   * Snapshots before each pull — rollback restores previous apex (or null = street order).
   */
  linkApexHistory: { linkId: string; apex: [number, number, number] | null }[]
  /**
   * View-path “film”: outer-shell camera keyframes from first walk.
   * live = record; playing/paused = scrub/replay without recording.
   */
  viewPath: ViewKeyframe[]
  viewPathMode: ViewPathMode
  /** Float index into viewPath [0 .. length-1] */
  viewPathCursor: number
  /** Inclusive selection for trim; null = none */
  viewPathSelectA: number | null
  viewPathSelectB: number | null
  /**
   * Roaming = view-path film; construction = AB base locked → build triangle;
   * retrospective = trace directed edges A→C, B→C.
   */
  cameraLens: 'roaming' | 'construction' | 'retrospective' | 'tetrahedron'
  constructionLinkId: string | null
  /**
   * key 面板对比：无 EmphasisLink。
   * 只钉配对供构建条显示「key 面板对比」；不做 rail/穿洞/俯视三角。
   */
  keyComparePair: { keyA: string; keyB: string } | null
  /** @deprecated 已不用三角 */
  keyCompareTri: ConstructionTriangle | null
  retrospectiveLinkId: string | null
  /** Active tetrahedron corner 0..3 when cameraLens === 'tetrahedron' */
  tetrahedronCorner: TetCorner | null
  /** Soft look-at override — derived from objects; null = origin */
  cameraLookAt: [number, number, number] | null
  /** Free eye when in relation lenses — derived from objects; null = outer shell */
  cameraEye: [number, number, number] | null
  /** Perspective depth: comment layer near vs emphasis boards near */
  constructionDepth: ConstructionDepth
  /**
   * Coplanar pair spacing on the shared image plane (display only).
   * Only active in planar stage — zipper 靠近/远离.
   */
  constructionSpread: number
  /**
   * Construction journey: rail (mid→C) → crossing (穿洞) → planar (俯视+拉链间距).
   * Not one continuous t — crossing is a discrete topological passage.
   */
  constructionStage: ConstructionStage
  /** Rail only: segment mid along M→C (0..1). At 1 → hole → crossing. */
  constructionMidLift: number
  /** Crossing only: 0..1 camera through C. */
  constructionCross: number
  /** +1 = mid→C→planar；-1 = planar→洞→rail（C 填回 M） */
  constructionCrossDir: 1 | -1
  /**
   * Comment layer C: always present in planar.
   * true = 现身（G 开启后可编文本）；false = 隐身。
   * 穿洞后的第一俯视默认为 false，仅 G 现身。
   */
  commentLayerExpanded: boolean
  /**
   * 结算架转球：每次 setPokerYawOffset 后 +1，驱动 PageMesh 重算 home。
   */
  settlementSphereEpoch: number
  tetraAnchorLinkId: string | null
  tetraCandidateDId: string | null
  enterConstructionLens: (linkId: string) => void
  /** 两 key 面板对比：只钉配对 + 构建条「key 面板对比」；无 rail/穿洞三角 */
  enterKeyCompareLens: (input: {
    keyA: string
    keyB: string
    lookAt?: [number, number, number] | null
  }) => void
  /** @deprecated 不再用三角；保留空实现以免旧调用崩 */
  refreshKeyCompareTriangle: (_input?: {
    pointA: [number, number, number]
    pointB: [number, number, number]
  }) => void
  exitConstructionLens: () => void
  flipConstructionDepth: () => void
  /** Planar zipper: negative = 靠近, positive = 远离 */
  nudgeConstructionSpread: (delta: number) => void
  setConstructionSpread: (spread: number) => void
  /** Rail: lift mid toward C; at 1 starts crossing. Planar: no-op (use spread). */
  nudgeConstructionMidLift: (delta: number) => void
  /** Advance crossing animation; completes → planar. */
  tickConstructionCrossing: (dt: number) => void
  /** true = 现身可编；false = 隐身（评论层仍在 C） */
  setCommentLayerExpanded: (visible: boolean) => void
  toggleCommentLayer: () => void
  updateEmphasisLinkNote: (linkId: string, note: string) => void
  /** While true, canvas pan ignores pointer (zipper / UI drag) */
  suppressCameraOrbit: boolean
  setSuppressCameraOrbit: (v: boolean) => void
  /**
   * Construction/retrospective: truck eye+look on the image plane
   * (screen drag → slide view to inspect emphases; wheel still zooms).
   */
  panConstructionView: (screenDx: number, screenDy: number) => void
  /** Roaming: LMB truck on view plane (updates viewPan). */
  panRoamingView: (screenDx: number, screenDy: number) => void
  /**
   * Rail concentric-sphere view: RMB orbits eye around lookAt
   * (does not exit construction lens).
   */
  orbitConstructionRail: (dyaw: number, dpitch: number) => void
  enterRetrospectiveLens: (linkId: string) => void
  exitRetrospectiveLens: () => void
  enterTetrahedronLens: (corner?: TetCorner) => void
  /** Expand built triangle ABC + candidate D into Fig.9 projection */
  enterAnchoredTetrahedron: (linkId: string, dEmphasisId?: string) => void
  cycleTetraCandidateD: () => void
  cycleTetrahedronCorner: () => void
  exitTetrahedronLens: () => void
  setWorkbenchOpen: (open: boolean) => void
  toggleWorkbench: () => void
  setWorkbenchTab: (tab: 'emphasis' | 'beams' | 'agent') => void
  setStarMapOpen: (open: boolean) => void
  /** Space+G：星图 + 强调笔同开通关（构建/回溯时并含评论层） */
  toggleStarMapWithG: () => void
  /** 星图与强调笔绑定开/关；禁止单独出 */
  setStarMapAndPen: (open: boolean) => void
  openOverview: (ids: string[]) => void
  /** Soft replace board ids (filters) — keeps pending endpoint A if still on board */
  setOverviewIds: (ids: string[]) => void
  setLastAgentHitIds: (ids: string[]) => void
  closeOverview: () => void
  openLinkFocus: (linkId: string) => void
  closeLinkFocus: () => void
  swapLinkFocus: () => void
  setCorpus: (c: CorpusId) => void
  applyUploadedUniverse: (data: {
    pages: PageDocument[]
    connections: ResolvedConnection[]
    label: string
    /** 语料包 / 并行 ingest 可直接带上 OCR */
    ocrByStrand?: Record<number, OcrPageResult>
    /**
     * 写信台工作台：默认不亮球；结算审计 bookKey 时再出页图。
     * 瘦载入语料包时应 true。
     */
    letterWorkbench?: boolean
  }) => void
  /** 后台中间页落账：替换 stub 页 + 合并 OCR，不重置工作区 */
  mergeIngestPage: (page: PageDocument, ocr: OcrPageResult) => void
  /**
   * 审计用：物化该 strand 页图（金库 data URI → blob），并亮球。
   * 已有 imageUrl 则只亮球。
   */
  ensurePageForAudit: (
    strandIndex: number,
    opts?: { focus?: boolean },
  ) => Promise<{ ok: boolean; note: string }>
  revealSphereForAudit: () => void
  hideSphereAfterAudit: () => void
  /** 结算球：登记 infer 激活的 strand（多页同球） */
  registerAuditSphereStrand: (strandIndex: number) => void
  clearAuditSphereStrands: () => void
  setLetterWorkbenchMode: (on: boolean) => void
  /** 写信台优先：隐藏球直到审计 */
  letterWorkbenchMode: boolean
  /** 结算审计时临时亮球 */
  sphereAuditOpen: boolean
  /** 结算球上应展示的 strand（infer 激活页）；空 = 未限定 */
  auditSphereStrands: number[]
  /** Wipe emphases / links / bonds / beams (memory + localStorage). Pages stay. */
  clearWorkspaceAnnotations: () => void
  setUploadProgress: (
    p: { current: number; total: number; message: string } | null,
  ) => void
  setEmphasizeMode: (on: boolean) => void
  /** Aim-select a page for circling — no camera swoop (pose stays stable for UV). */
  aimEmphasizePage: (strandIndex: number) => void
  clearEmphasisDraft: () => void
  endEmphasisStroke: () => void
  emphasisPointer: (
    localX: number,
    localY: number,
    phase: 'down' | 'move' | 'up',
  ) => void
  /** Seal draft onto strandIndex (defaults to currentStrand). Pass confirmedRing to skip re-detection. */
  sealEmphasisDraft: (strandIndex?: number, confirmedRing?: PagePoint[]) => string | null
  selectEmphasis: (id: string | null) => void
  /** Select emphasis and fly to its page (local geometry only). */
  navigateToEmphasis: (id: string) => boolean
  updateEmphasisReading: (id: string, reading: string) => void
  deleteEmphasis: (id: string) => void
  setEmphasisLinkFrom: (id: string | null) => void
  createEmphasisLink: (toEmphasisId: string, note?: string) => string | null
  deleteEmphasisLink: (linkId: string) => void
  beginDragLinkApex: (
    linkId: string,
    initialPos?: [number, number, number],
  ) => void
  updateDragLinkApex: (pos: [number, number, number]) => void
  endDragLinkApex: () => void
  clearLinkApex: (linkId: string) => void
  /** Undo last purple-line pull (restore previous apex / street order) */
  rollbackLinkApex: () => boolean
  clearPromptReading: () => void
  appendPipelineNote: (summary: string) => void
  /**
   * Demo: Agent draws two figure regions (animated draft → seal) then builds
   * a cross-page link and enters construction lens.
   */
  runAiProposeAndLinkDemo: () => Promise<{
    fromId: string
    toId: string
    linkId: string
  } | null>
  runOcrOnCurrentPage: (opts?: { force?: boolean }) => Promise<void>
  /**
   * OCR pages that have image but no OCR yet.
   * Used after upload when autoOcrOnUpload is on.
   * Set deferIndexSync when caller will finalizeIndex right after.
   * Set forceEvenIfPdfText when PDF glyph textChunks should not skip OCR
   * (glyph merge often cross-stitches dual columns / spreads).
   */
  runOcrOnPagesLackingText: (opts?: {
    maxPages?: number
    concurrency?: number
    onProgress?: (done: number, total: number, strand: number) => void
    deferIndexSync?: boolean
    /** Upload path: do not skip just because pdf.js left textChunks */
    forceEvenIfPdfText?: boolean
  }) => Promise<{ done: number; failed: number }>
  closeOcrPanel: () => void
  setOcrHoverBlock: (id: string | null) => void
  setOcrEditingBlockId: (id: string | null) => void
  beginOcrInlineEdit: (id: string) => void
  endOcrInlineEdit: () => void
  updateOcrBlockContent: (blockId: string, content: string) => void
  restoreOcrBlockContent: (blockId: string) => void
  confirmOcrBlock: (blockId: string) => void
  deleteOcrBlock: (blockId: string) => void
  addOcrBlock: (opts?: {
    content?: string
    bbox?: [number, number, number, number]
    label?: string
  }) => string | null
  addOcrBlockAtLocalPoint: (localX: number, localY: number) => string | null
  sealPermanentBond: (opts: {
    ocrBlockId: string
    comment: string
  }) => string | null
  /**
   * Peek / 注意力窗 = 评论层实体：OCR 框心 → bond（左 confirmedText · 右 comment=brief）。
   * Upsert by bookKey when possible.
   */
  sealAttentionBond: (opts: {
    strandIndex: number
    bbox: [number, number, number, number]
    confirmedText: string
    comment: string
    bookKey: string
    briefKey: string
  }) => string
  updateBondComment: (bondId: string, comment: string) => void
  deletePermanentBond: (bondId: string) => void
  setBondLinkFrom: (bondId: string | null) => void
  createUserBeam: (toBondId: string, flinkType?: FlinkType) => string | null
  deleteUserBeam: (beamId: string) => void
  refreshConnectionsOnCurrent: () => void
  selectConnection: (id: string) => void
  stepConnection: (dir: 1 | -1) => void
  flipToCompanion: () => void
  swapPages: () => void
  swoopAlongCurrent: () => void
  /**
   * Nelson-style: click a beam → make its two ends current/companion and
   * traverse (swap) to the other end if already on one.
   */
  traverseAlongPair: (
    strandA: number,
    strandB: number,
    opts?: {
      connectionId?: string
      emphasisFromId?: string
      emphasisToId?: string
    },
  ) => void
  swoopToPage: (strandIndex: number) => void
  stepPage: (dir: 1 | -1) => void
  followCurrentConnection: () => void
  setCameraDistance: (d: number) => void
  /** Translate look target in world space (free camera truck/pedestal/dolly overrun) */
  panView: (delta: [number, number, number]) => void
  resetViewPan: () => void
  orbit: (dyaw: number, dpitch: number) => void
  commitViewKeyframe: (opts?: {
    tag?: ViewKeyframeTag
    force?: boolean
  }) => void
  playViewPath: () => void
  pauseViewPath: () => void
  liveViewPath: () => void
  setViewPathCursor: (cursor: number) => void
  tickViewPathPlayback: (dt: number) => void
  deleteViewPathFrameAt: (index: number) => void
  deleteViewPathSelection: () => void
  setViewPathSelectMark: (index: number) => void
  clearViewPathSelection: () => void
  clearViewPath: () => void
}

export const useDocuverse = create<DocuverseState>((set, get) => ({
  corpus: 'upload',
  uploadLabel: null,
  uploadProgress: null,
  pages: initial.pages,
  connections: initial.connections,
  currentStrand: 0,
  companionStrand: initialConn ? companionOf(initialConn, 0) : 1,
  currentConnectionId: initialConn?.id ?? null,
  connectionsOnCurrent: initialOnCurrent,
  connectionCursor: 0,
  cameraDistance: readingOuterRadius(Math.max(initial.pages.length, 1)),
  viewYaw: radialToYawPitch(
    pageRadialDirection(0, Math.max(initial.pages.length, 1)),
  ).yaw,
  viewPitch: radialToYawPitch(
    pageRadialDirection(0, Math.max(initial.pages.length, 1)),
  ).pitch,
  viewPan: [0, 0, 0],
  swooping: false,
  ocrOpen: false,
  ocrBusy: false,
  ocrError: null,
  ocrActiveStrand: null,
  ocrByStrand: {},
  ocrHoverBlock: null,
  ocrEditingBlockId: null,
  ocrInlineEdit: false,
  permanentBonds: initialBonds.bonds,
  userBeams: initialBonds.beams,
  bondLinkFromId: null,
  emphasisEdges: initialEmphasis.edges,
  emphasisLinks: initialEmphasis.links,
  pipelineSteps: initialEmphasis.pipeline,
  emphasizeMode: false,
  emphasisStrokeActive: false,
  emphasisDraftPoints: [],
  emphasisDraftStrand: null,
  selectedEmphasisId: null,
  emphasisLinkFromId: null,
  promptReadingForId: null,
  workbenchOpen: false,
  workbenchTab: 'emphasis',
  starMapOpen: false,
  overviewOpen: false,
  overviewIds: [],
  lastAgentHitIds: [],
  aiDemoRunning: false,
  aiDemoStatus: null,
  linkFocusId: null,
  linkFocusMainIsFrom: true,
  draggingLinkId: null,
  linkApexHistory: [],
  viewPath: [],
  viewPathMode: 'live',
  viewPathCursor: 0,
  viewPathSelectA: null,
  viewPathSelectB: null,
  cameraLens: 'roaming',
  constructionLinkId: null,
  keyComparePair: null,
  keyCompareTri: null,
  retrospectiveLinkId: null,
  tetrahedronCorner: null,
  cameraLookAt: null,
  cameraEye: null,
  constructionDepth: 'commentNear' as ConstructionDepth,
  constructionSpread: 1.15,
  constructionStage: 'rail' as ConstructionStage,
  constructionMidLift: 0,
  constructionCross: 0,
  constructionCrossDir: 1 as 1 | -1,
  commentLayerExpanded: false,
  settlementSphereEpoch: 0,
  letterWorkbenchMode: false,
  sphereAuditOpen: false,
  auditSphereStrands: [],
  suppressCameraOrbit: false,
  tetraAnchorLinkId: null,
  tetraCandidateDId: null,

  enterConstructionLens: (linkId) => {
    const s = get()
    const link = s.emphasisLinks.find((l) => l.id === linkId)
    const from = s.emphasisEdges.find((e) => e.id === link?.fromEmphasisId)
    const to = s.emphasisEdges.find((e) => e.id === link?.toEmphasisId)
    if (!link || !from || !to) return
    const total = Math.max(s.pages.length, 1)
    const tri = triangleForLink(from, to, total, null)
    if (!tri) return
    const pose = constructionPoseForStage(
      tri,
      'rail',
      0,
      0,
      s.constructionDepth,
      s.constructionSpread,
    )
    if (s.viewPathMode === 'playing') get().pauseViewPath()
    set({
      emphasisLinks: s.emphasisLinks.map((l) =>
        l.id === linkId
          ? { ...l, commentCenter: tri.c, apex: null }
          : l,
      ),
      cameraLens: 'construction',
      constructionLinkId: linkId,
      keyComparePair: null,
      keyCompareTri: null,
      retrospectiveLinkId: null,
      tetrahedronCorner: null,
      tetraAnchorLinkId: null,
      linkFocusId: null,
      draggingLinkId: null,
      overviewOpen: false,
      workbenchOpen: false,
      // Keep 强调笔 if already on — annotate from any lens / page
      selectedEmphasisId: from.id,
      currentStrand: from.strandIndex,
      companionStrand: to.strandIndex,
      cameraLookAt: pose.lookAt,
      cameraEye: pose.eye,
      viewYaw: pose.yaw,
      viewPitch: pose.pitch,
      cameraDistance: pose.distance,
      viewPan: [0, 0, 0],
      swooping: true,
      commentLayerExpanded: false,
      constructionStage: 'rail',
      constructionMidLift: 0,
      constructionCross: 0,
      constructionCrossDir: 1,
    })
    persistEmphasis(get)
    setTimeout(() => set({ swooping: false }), 1100)
  },

  enterKeyCompareLens: ({ keyA, keyB, lookAt }) => {
    const s = get()
    if (s.viewPathMode === 'playing') get().pauseViewPath()
    set({
      cameraLens: 'construction',
      constructionLinkId: null,
      keyComparePair: { keyA, keyB },
      keyCompareTri: null,
      retrospectiveLinkId: null,
      tetrahedronCorner: null,
      tetraAnchorLinkId: null,
      linkFocusId: null,
      draggingLinkId: null,
      overviewOpen: false,
      workbenchOpen: false,
      // 软看向两面板中点；不进 rail/穿洞机位
      cameraLookAt: lookAt ?? null,
      cameraEye: null,
      viewPan: [0, 0, 0],
      swooping: false,
      commentLayerExpanded: false,
      constructionStage: 'rail',
      constructionMidLift: 0,
      constructionCross: 0,
      constructionCrossDir: 1,
    })
  },

  refreshKeyCompareTriangle: () => {
    /* no-op：key 对比不再维护三角 */
  },

  flipConstructionDepth: () => {
    const s = get()
    const next: ConstructionDepth =
      s.constructionDepth === 'commentNear' ? 'emphasisNear' : 'commentNear'
    set({ constructionDepth: next })
    if (s.cameraLens === 'construction' && s.constructionLinkId) {
      get().enterConstructionLens(s.constructionLinkId)
    }
    // key 对比无三角可翻
  },

  nudgeConstructionSpread: (delta) => {
    if (get().constructionStage !== 'planar') return
    const next = Math.max(
      0.35,
      Math.min(2.8, get().constructionSpread + delta),
    )
    if (Math.abs(next - get().constructionSpread) < 1e-6) return
    set({ constructionSpread: next })
  },

  setConstructionSpread: (spread) => {
    const next = Math.max(0.35, Math.min(2.8, spread))
    if (Math.abs(next - get().constructionSpread) < 1e-6) return
    set({ constructionSpread: next })
  },

  nudgeConstructionMidLift: (delta) => {
    const s = get()
    // key 面板对比：无 rail/穿洞
    if (s.keyComparePair && !s.constructionLinkId) return
    if (s.cameraLens !== 'construction' && s.cameraLens !== 'retrospective') {
      return
    }
    if (s.constructionStage === 'crossing') return

    const link = s.emphasisLinks.find(
      (l) => l.id === (s.constructionLinkId ?? s.retrospectiveLinkId),
    )
    const from = s.emphasisEdges.find((e) => e.id === link?.fromEmphasisId)
    const to = s.emphasisEdges.find((e) => e.id === link?.toEmphasisId)
    const tri =
      link && from && to
        ? triangleForLink(from, to, Math.max(s.pages.length, 1), null)
        : null

    if (s.constructionStage === 'planar') {
      // Vertical only: up=靠近, down=远离; past max spread → reverse through hole
      const spreadDelta = -delta * 2.2
      const nextSpread = Math.max(
        0.35,
        Math.min(2.8, s.constructionSpread + spreadDelta),
      )
      if (
        spreadDelta > 0 &&
        s.constructionSpread >= 2.75 - 1e-6 &&
        nextSpread >= 2.75 &&
        tri
      ) {
        const pose = constructionPoseForStage(
          tri,
          'crossing',
          1,
          1,
          s.constructionDepth,
          s.constructionSpread,
        )
        set({
          constructionStage: 'crossing',
          constructionCross: 1,
          constructionCrossDir: -1,
          commentLayerExpanded: false,
          cameraEye: pose.eye,
          cameraLookAt: pose.lookAt,
          viewYaw: pose.yaw,
          viewPitch: pose.pitch,
          cameraDistance: pose.distance,
          swooping: true,
        })
        setTimeout(() => set({ swooping: false }), 400)
        return
      }
      if (Math.abs(nextSpread - s.constructionSpread) < 1e-6) return
      set({ constructionSpread: nextSpread })
      return
    }

    // Rail: mid climbs M→C. Camera stays put until crossing.
    // Already parked at/near C (e.g. after reverse 穿洞): further push toward C
    // re-enters the hole → zipper (planar). Pull back lowers mid along the axis.
    if (
      tri &&
      s.constructionMidLift >= 0.92 &&
      delta > 0.0015
    ) {
      const pose = constructionPoseForStage(
        tri,
        'crossing',
        1,
        0,
        s.constructionDepth,
        s.constructionSpread,
      )
      set({
        constructionMidLift: 1,
        constructionStage: 'crossing',
        constructionCross: 0,
        constructionCrossDir: 1,
        cameraEye: pose.eye,
        cameraLookAt: pose.lookAt,
        viewYaw: pose.yaw,
        viewPitch: pose.pitch,
        cameraDistance: pose.distance,
        commentLayerExpanded: false,
        swooping: true,
      })
      setTimeout(() => set({ swooping: false }), 400)
      return
    }

    const next = Math.max(0, Math.min(1, s.constructionMidLift + delta))
    // Soft snap into the hole when climbing toward C
    const snap = next >= 0.72 ? 1 : next
    if (!tri) {
      set({ constructionMidLift: snap })
      return
    }
    if (snap >= 0.995 && s.constructionMidLift < 0.92) {
      const pose = constructionPoseForStage(
        tri,
        'crossing',
        1,
        0,
        s.constructionDepth,
        s.constructionSpread,
      )
      set({
        constructionMidLift: 1,
        constructionStage: 'crossing',
        constructionCross: 0,
        constructionCrossDir: 1,
        cameraEye: pose.eye,
        cameraLookAt: pose.lookAt,
        viewYaw: pose.yaw,
        viewPitch: pose.pitch,
        cameraDistance: pose.distance,
        commentLayerExpanded: false,
        swooping: true,
      })
      setTimeout(() => set({ swooping: false }), 400)
      return
    }
    if (Math.abs(snap - s.constructionMidLift) < 1e-6) return
    set({ constructionMidLift: snap })
  },

  tickConstructionCrossing: (dt) => {
    const s = get()
    if (s.constructionStage !== 'crossing') return
    // key 面板对比无穿洞
    if (s.keyComparePair && !s.constructionLinkId) return
    const linkId = s.constructionLinkId ?? s.retrospectiveLinkId
    if (!linkId) return
    const link = s.emphasisLinks.find((l) => l.id === linkId)
    const from = s.emphasisEdges.find((e) => e.id === link?.fromEmphasisId)
    const to = s.emphasisEdges.find((e) => e.id === link?.toEmphasisId)
    if (!link || !from || !to) return
    const tri = triangleForLink(from, to, Math.max(s.pages.length, 1), null)
    if (!tri) return
    const dir = s.constructionCrossDir
    const next =
      dir >= 0
        ? Math.min(1, s.constructionCross + dt * 0.85)
        : Math.max(0, s.constructionCross - dt * 0.85)

    if (dir >= 0 && next >= 1) {
      const pose = constructionPoseForStage(
        tri,
        'planar',
        1,
        1,
        s.constructionDepth,
        s.constructionSpread,
      )
      set({
        constructionStage: 'planar',
        constructionCross: 1,
        constructionMidLift: 1,
        constructionCrossDir: 1,
        // 穿洞后第一视图：评论隐身，仅 G 现身
        commentLayerExpanded: false,
        cameraEye: pose.eye,
        cameraLookAt: pose.lookAt,
        viewYaw: pose.yaw,
        viewPitch: pose.pitch,
        cameraDistance: pose.distance,
        swooping: true,
      })
      setTimeout(() => set({ swooping: false }), 700)
      return
    }

    if (dir < 0 && next <= 0) {
      // Back on rail: C fills M — solid mid sits on C, ready to slide down
      const pose = constructionPoseForStage(
        tri,
        'rail',
        1,
        0,
        s.constructionDepth,
        s.constructionSpread,
      )
      set({
        constructionStage: 'rail',
        constructionCross: 0,
        // Park on true A–B mid (原球体语义); 机位仍用 rail pose. 再拖向 C 穿洞回拉链.
        constructionMidLift: 0,
        constructionCrossDir: 1,
        constructionSpread: 1.15,
        commentLayerExpanded: false,
        suppressCameraOrbit: false,
        cameraEye: pose.eye,
        cameraLookAt: pose.lookAt,
        viewYaw: pose.yaw,
        viewPitch: pose.pitch,
        cameraDistance: pose.distance,
        swooping: true,
      })
      setTimeout(() => set({ swooping: false }), 700)
      return
    }

    const pose = constructionPoseForStage(
      tri,
      'crossing',
      1,
      next,
      s.constructionDepth,
      s.constructionSpread,
    )
    set({
      constructionCross: next,
      cameraEye: pose.eye,
      cameraLookAt: pose.lookAt,
      viewYaw: pose.yaw,
      viewPitch: pose.pitch,
      cameraDistance: pose.distance,
    })
  },

  setCommentLayerExpanded: (visible) => {
    const s = get()
    if (
      s.cameraLens !== 'construction' &&
      s.cameraLens !== 'retrospective'
    ) {
      return
    }
    if (visible && s.constructionStage !== 'planar') {
      // Jump through hole to planar; comment layer appears at C (text editable)
      const linkId = s.constructionLinkId ?? s.retrospectiveLinkId
      const link = s.emphasisLinks.find((l) => l.id === linkId)
      const from = s.emphasisEdges.find((e) => e.id === link?.fromEmphasisId)
      const to = s.emphasisEdges.find((e) => e.id === link?.toEmphasisId)
      if (link && from && to) {
        const tri = triangleForLink(from, to, Math.max(s.pages.length, 1), null)
        if (tri) {
          const pose = constructionPoseForStage(
            tri,
            'planar',
            1,
            1,
            s.constructionDepth,
            s.constructionSpread,
          )
          set({
            constructionStage: 'planar',
            constructionMidLift: 1,
            constructionCross: 1,
            commentLayerExpanded: true,
            starMapOpen: true,
            emphasizeMode: true,
            cameraEye: pose.eye,
            cameraLookAt: pose.lookAt,
            viewYaw: pose.yaw,
            viewPitch: pose.pitch,
            cameraDistance: pose.distance,
          })
          return
        }
      }
    }
    // 构建/回溯：评论层与星图+强调笔同开通关
    set({
      commentLayerExpanded: visible,
      starMapOpen: visible,
      emphasizeMode: visible,
      ...(visible
        ? {}
        : {
            emphasisStrokeActive: false,
            emphasisDraftPoints: [],
            emphasisDraftStrand: null,
          }),
    })
  },

  toggleCommentLayer: () => {
    const s = get()
    if (
      s.cameraLens !== 'construction' &&
      s.cameraLens !== 'retrospective'
    ) {
      return
    }
    // Space+G = 隐身/现身（与星图+强调笔同步）
    get().setCommentLayerExpanded(!s.commentLayerExpanded)
  },

  updateEmphasisLinkNote: (linkId, note) => {
    const trimmed = note
    set({
      emphasisLinks: get().emphasisLinks.map((l) =>
        l.id === linkId ? { ...l, note: trimmed } : l,
      ),
    })
    persistEmphasis(get)
  },

  setSuppressCameraOrbit: (v) => set({ suppressCameraOrbit: v }),

  panConstructionView: (screenDx, screenDy) => {
    const s = get()
    if (
      s.cameraLens !== 'construction' &&
      s.cameraLens !== 'retrospective'
    ) {
      return
    }
    if (!s.cameraEye || !s.cameraLookAt) return
    if (Math.abs(screenDx) < 1e-8 && Math.abs(screenDy) < 1e-8) return

    const [ex, ey, ez] = s.cameraEye
    const [lx, ly, lz] = s.cameraLookAt
    const fx = lx - ex
    const fy = ly - ey
    const fz = lz - ez
    const fl = Math.hypot(fx, fy, fz)
    if (fl < 1e-6) return
    const fxi = fx / fl
    const fyi = fy / fl
    const fzi = fz / fl

    // Camera right × up from look axis (world Y as reference up)
    let rx = fyi * 0 - 1 * fzi
    let ry = fzi * 0 - fxi * 0
    let rz = fxi * 1 - fyi * 0
    // cross(forward, worldUp=(0,1,0)) = (fz, 0, -fx) wait:
    // forward × up = (fy*0 - fz*1, fz*0 - fx*0, fx*1 - fy*0) = (-fz, 0, fx)
    rx = -fzi
    ry = 0
    rz = fxi
    let rl = Math.hypot(rx, ry, rz)
    if (rl < 1e-6) {
      // Looking nearly along Y — use world X as up reference
      rx = fyi * 0 - fzi * 0
      ry = fzi * 1 - fxi * 0
      rz = fxi * 0 - fyi * 1
      // forward × (1,0,0) = (0*0 - fz*0, fz*1 - fx*0, fx*0 - fy*1) = (0, fz, -fy)
      rx = 0
      ry = fzi
      rz = -fyi
      rl = Math.hypot(rx, ry, rz)
      if (rl < 1e-6) return
    }
    rx /= rl
    ry /= rl
    rz /= rl
    // up = right × forward? Actually up = right × (-forward) for RH... 
    // up = cross(right, -forward) no: standard is up = cross(right, forward) if forward is look dir from eye...
    // Camera: right = normalize(forward × worldUp), up = cross(right, forward) with forward = look-eye
    // cross(right, forward):
    const ux = ry * fzi - rz * fyi
    const uy = rz * fxi - rx * fzi
    const uz = rx * fyi - ry * fxi
    const ul = Math.hypot(ux, uy, uz)
    if (ul < 1e-6) return
    const uxi = ux / ul
    const uyi = uy / ul
    const uzi = uz / ul

    // Grab-pan: drag right → content follows → camera trucks left
    // Scale with view distance so zoomed-in pans are finer
    const scale = fl * 0.00165
    const mx = (-screenDx * rx + screenDy * uxi) * scale
    const my = (-screenDx * ry + screenDy * uyi) * scale
    const mz = (-screenDx * rz + screenDy * uzi) * scale

    const nextEye: [number, number, number] = [ex + mx, ey + my, ez + mz]
    const nextLook: [number, number, number] = [lx + mx, ly + my, lz + mz]
    const len = Math.hypot(nextEye[0], nextEye[1], nextEye[2])
    const yaw = Math.atan2(nextEye[0], nextEye[2])
    const pitch = Math.asin(
      Math.max(-1, Math.min(1, nextEye[1] / Math.max(len, 1e-8))),
    )
    set({
      cameraEye: nextEye,
      cameraLookAt: nextLook,
      viewYaw: yaw,
      viewPitch: pitch,
      cameraDistance: len,
    })
  },

  panRoamingView: (screenDx, screenDy) => {
    const s = get()
    if (s.emphasizeMode || s.emphasisStrokeActive) return
    if (
      s.cameraLens === 'construction' ||
      s.cameraLens === 'retrospective' ||
      s.cameraLens === 'tetrahedron'
    ) {
      return
    }
    if (Math.abs(screenDx) < 1e-8 && Math.abs(screenDy) < 1e-8) return

    const eyeDir = yawPitchToRadial(s.viewYaw, s.viewPitch).normalize()
    const fx = -eyeDir.x
    const fy = -eyeDir.y
    const fz = -eyeDir.z

    let rx = -fz
    let ry = 0
    let rz = fx
    let rl = Math.hypot(rx, ry, rz)
    if (rl < 1e-6) {
      rx = 0
      ry = fz
      rz = -fy
      rl = Math.hypot(rx, ry, rz)
      if (rl < 1e-6) return
    }
    rx /= rl
    ry /= rl
    rz /= rl

    const ux = ry * fz - rz * fy
    const uy = rz * fx - rx * fz
    const uz = rx * fy - ry * fx
    const ul = Math.hypot(ux, uy, uz)
    if (ul < 1e-6) return
    const uxi = ux / ul
    const uyi = uy / ul
    const uzi = uz / ul

    const scale = s.cameraDistance * 0.00085
    const mx = (-screenDx * rx + screenDy * uxi) * scale
    const my = (-screenDx * ry + screenDy * uyi) * scale
    const mz = (-screenDx * rz + screenDy * uzi) * scale

    set({
      viewPan: [s.viewPan[0] + mx, s.viewPan[1] + my, s.viewPan[2] + mz],
      ...(s.cameraLookAt || s.cameraEye
        ? {
            cameraLookAt: null,
            cameraEye: null,
            cameraLens: 'roaming' as const,
            tetrahedronCorner: null,
            tetraAnchorLinkId: null,
          }
        : {}),
    })
  },

  orbitConstructionRail: (dyaw, dpitch) => {
    const s = get()
    if (
      s.cameraLens !== 'construction' &&
      s.cameraLens !== 'retrospective'
    ) {
      return
    }
    // Planar keeps grab-pan; rail (同心球) orbits around look without exiting lens
    if (s.constructionStage !== 'rail') return
    if (!s.cameraEye || !s.cameraLookAt) return

    const eye = new THREE.Vector3(...s.cameraEye)
    const look = new THREE.Vector3(...s.cameraLookAt)
    const offset = eye.clone().sub(look)
    if (offset.length() < 0.2) return

    const spherical = new THREE.Spherical().setFromVector3(offset)
    spherical.theta -= dyaw
    spherical.phi = THREE.MathUtils.clamp(
      spherical.phi - dpitch,
      0.08,
      Math.PI - 0.08,
    )
    offset.setFromSpherical(spherical)
    const nextEye = look.clone().add(offset)
    const { yaw, pitch } = radialToYawPitch(nextEye)
    set({
      cameraEye: [nextEye.x, nextEye.y, nextEye.z],
      viewYaw: yaw,
      viewPitch: pitch,
      cameraDistance: nextEye.length(),
    })
  },

  exitConstructionLens: () => {
    set({
      cameraLens: 'roaming',
      constructionLinkId: null,
      keyComparePair: null,
      keyCompareTri: null,
      cameraLookAt: null,
      cameraEye: null,
      commentLayerExpanded: false,
      suppressCameraOrbit: false,
      constructionStage: 'rail',
      constructionMidLift: 0,
      constructionCross: 0,
      swooping: true,
    })
    setTimeout(() => set({ swooping: false }), 700)
  },

  enterRetrospectiveLens: (linkId) => {
    const s = get()
    const link = s.emphasisLinks.find((l) => l.id === linkId)
    const from = s.emphasisEdges.find((e) => e.id === link?.fromEmphasisId)
    const to = s.emphasisEdges.find((e) => e.id === link?.toEmphasisId)
    if (!link || !from || !to) return
    const total = Math.max(s.pages.length, 1)
    const tri = triangleForLink(from, to, total, null)
    if (!tri) return
    const pose = constructionFaceOnPose(tri, 'commentNear', s.constructionSpread)
    if (s.viewPathMode === 'playing') get().pauseViewPath()
    set({
      emphasisLinks: s.emphasisLinks.map((l) =>
        l.id === linkId ? { ...l, commentCenter: tri.c, apex: null } : l,
      ),
      cameraLens: 'retrospective',
      retrospectiveLinkId: linkId,
      constructionLinkId: null,
      tetrahedronCorner: null,
      tetraAnchorLinkId: null,
      linkFocusId: null,
      draggingLinkId: null,
      cameraLookAt: pose.lookAt,
      cameraEye: pose.eye,
      viewYaw: pose.yaw,
      viewPitch: pose.pitch,
      cameraDistance: pose.distance,
      swooping: true,
      commentLayerExpanded: false,
      constructionStage: 'planar',
      constructionMidLift: 1,
      constructionCross: 1,
    })
    persistEmphasis(get)
    setTimeout(() => set({ swooping: false }), 1100)
  },

  exitRetrospectiveLens: () => {
    set({
      cameraLens: 'roaming',
      retrospectiveLinkId: null,
      cameraLookAt: null,
      cameraEye: null,
      commentLayerExpanded: false,
      suppressCameraOrbit: false,
      swooping: true,
    })
    setTimeout(() => set({ swooping: false }), 700)
  },

  enterAnchoredTetrahedron: (linkId, dEmphasisId) => {
    const s = get()
    const link = s.emphasisLinks.find((l) => l.id === linkId)
    const from = s.emphasisEdges.find((e) => e.id === link?.fromEmphasisId)
    const to = s.emphasisEdges.find((e) => e.id === link?.toEmphasisId)
    if (!link || !from || !to) return
    const total = Math.max(s.pages.length, 1)
    const dEdge = pickCandidateD(
      s.emphasisEdges,
      from.id,
      to.id,
      total,
      dEmphasisId ?? s.tetraCandidateDId,
    )
    if (!dEdge) {
      // No fourth emphasis yet — fall back to face-on construction
      get().enterConstructionLens(linkId)
      return
    }
    const tet = buildAnchoredTetrahedron(link, from, to, dEdge, total)
    if (!tet) return
    const pose = anchoredTetrahedronProjectionPose(tet)
    if (s.viewPathMode === 'playing') get().pauseViewPath()
    set({
      cameraLens: 'tetrahedron',
      tetraAnchorLinkId: linkId,
      tetraCandidateDId: dEdge.id,
      tetrahedronCorner: null,
      constructionLinkId: null,
      retrospectiveLinkId: null,
      cameraLookAt: pose.lookAt,
      cameraEye: pose.eye,
      viewYaw: pose.yaw,
      viewPitch: pose.pitch,
      cameraDistance: pose.distance,
      swooping: true,
    })
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: `锚面四面体扩展 · ABC 已建联 · D=s${dEdge.strandIndex}`,
      detail: { linkId, dEmphasisId: dEdge.id },
    })
    setTimeout(() => set({ swooping: false }), 1100)
  },

  cycleTetraCandidateD: () => {
    const s = get()
    const linkId = s.tetraAnchorLinkId ?? s.constructionLinkId
    if (!linkId) return
    const link = s.emphasisLinks.find((l) => l.id === linkId)
    if (!link) return
    const others = s.emphasisEdges.filter(
      (e) => e.id !== link.fromEmphasisId && e.id !== link.toEmphasisId,
    )
    if (others.length === 0) return
    const idx = others.findIndex((e) => e.id === s.tetraCandidateDId)
    const next = others[(idx + 1) % others.length]
    get().enterAnchoredTetrahedron(linkId, next.id)
  },

  enterTetrahedronLens: (corner = 0) => {
    const s = get()
    // Prefer anchored expansion when a construction link is active
    if (s.constructionLinkId || s.tetraAnchorLinkId) {
      get().enterAnchoredTetrahedron(
        s.constructionLinkId ?? s.tetraAnchorLinkId!,
      )
      return
    }
    const total = Math.max(s.pages.length, 1)
    const tet = buildEmphasisTetrahedron(s.emphasisEdges, total)
    if (!tet) return
    const c = ((corner % 4) + 4) % 4 as TetCorner
    const pose = tetrahedronCornerPose(tet, c, total)
    if (s.viewPathMode === 'playing') get().pauseViewPath()
    const onFace = countEmphasesOnFace(tet, c)
    set({
      cameraLens: 'tetrahedron',
      tetrahedronCorner: c,
      tetraAnchorLinkId: null,
      constructionLinkId: null,
      retrospectiveLinkId: null,
      cameraLookAt: pose.lookAt,
      cameraEye: pose.eye,
      viewYaw: pose.yaw,
      viewPitch: pose.pitch,
      cameraDistance: pose.distance,
      swooping: true,
    })
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: `强调云四面体 · 角 ${c + 1}/4 · 对面约 ${onFace}/${s.emphasisEdges.length} 块`,
      detail: { corner: c, onFace, total: s.emphasisEdges.length },
    })
    setTimeout(() => set({ swooping: false }), 1100)
  },

  cycleTetrahedronCorner: () => {
    const s = get()
    if (s.tetraAnchorLinkId) {
      get().cycleTetraCandidateD()
      return
    }
    if (s.cameraLens !== 'tetrahedron') {
      get().enterTetrahedronLens(0)
      return
    }
    const next = (((s.tetrahedronCorner ?? 0) + 1) % 4) as TetCorner
    get().enterTetrahedronLens(next)
  },

  exitTetrahedronLens: () => {
    set({
      cameraLens: 'roaming',
      tetrahedronCorner: null,
      tetraAnchorLinkId: null,
      tetraCandidateDId: null,
      cameraLookAt: null,
      cameraEye: null,
      swooping: true,
    })
    setTimeout(() => set({ swooping: false }), 700)
  },

  setWorkbenchOpen: (open) => set({ workbenchOpen: open }),
  toggleWorkbench: () => set({ workbenchOpen: !get().workbenchOpen }),
  setWorkbenchTab: (tab) => set({ workbenchTab: tab, workbenchOpen: true }),

  setStarMapOpen: (open) => {
    get().setStarMapAndPen(open)
  },
  setStarMapAndPen: (open) => {
    if (!open) {
      get().clearEmphasisDraft()
    }
    set({
      starMapOpen: open,
      emphasizeMode: open,
      emphasisStrokeActive: false,
      emphasisDraftPoints: open ? get().emphasisDraftPoints : [],
      emphasisDraftStrand: open ? get().emphasisDraftStrand : null,
      workbenchOpen: open ? false : get().workbenchOpen,
      suppressCameraOrbit: false,
    })
    if (open) {
      pushPipeline(get, set, {
        kind: 'note',
        actor: 'user',
        summary:
          'Space+G：星图·建联 + 强调笔同开 · 瞄准选定页落笔；星图点线圈建联',
      })
    }
  },
  toggleStarMapWithG: () => {
    const s = get()
    const inCommentLens =
      s.cameraLens === 'construction' || s.cameraLens === 'retrospective'
    const currentlyOpen =
      s.starMapOpen ||
      s.emphasizeMode ||
      (inCommentLens && s.commentLayerExpanded)
    const next = !currentlyOpen
    get().setStarMapAndPen(next)
    if (inCommentLens) {
      get().setCommentLayerExpanded(next)
    }
  },

  openOverview: (ids) => {
    const unique = [...new Set(ids.filter(Boolean))]
    if (unique.length === 0) return
    set({
      overviewOpen: true,
      overviewIds: unique,
      workbenchOpen: false,
      linkFocusId: null,
      emphasizeMode: false,
      starMapOpen: false,
      emphasisStrokeActive: false,
      emphasisLinkFromId: null,
    })
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: `打开关联台：${unique.length} 块强调图卡 · 先选 A 再选 B`,
      detail: { count: unique.length },
    })
  },

  setOverviewIds: (ids) => {
    const unique = [...new Set(ids.filter(Boolean))]
    if (unique.length === 0) return
    const from = get().emphasisLinkFromId
    set({
      overviewIds: unique,
      emphasisLinkFromId: from && unique.includes(from) ? from : null,
    })
  },

  setLastAgentHitIds: (ids) =>
    set({ lastAgentHitIds: [...new Set(ids.filter(Boolean))] }),

  closeOverview: () =>
    set({
      overviewOpen: false,
      emphasisLinkFromId: null,
    }),

  openLinkFocus: (linkId) => {
    // Unified path: every existing link uses construction coplanar interaction
    get().enterConstructionLens(linkId)
  },

  closeLinkFocus: () => set({ linkFocusId: null, swooping: true }),

  swapLinkFocus: () => {
    const { linkFocusId, linkFocusMainIsFrom, emphasisLinks, emphasisEdges } =
      get()
    if (!linkFocusId) return
    const link = emphasisLinks.find((l) => l.id === linkFocusId)
    if (!link) return
    const from = emphasisEdges.find((e) => e.id === link.fromEmphasisId)
    const to = emphasisEdges.find((e) => e.id === link.toEmphasisId)
    if (!from || !to) return
    const mainIsFrom = !linkFocusMainIsFrom
    const main = mainIsFrom ? from : to
    const other = mainIsFrom ? to : from
    set({
      linkFocusMainIsFrom: mainIsFrom,
      selectedEmphasisId: main.id,
      currentStrand: main.strandIndex,
      companionStrand: other.strandIndex,
      swooping: true,
    })
    setTimeout(() => set({ swooping: false }), 900)
  },

  setCorpus: (c) => {
    if (c === 'upload' && !uploadedBuilt) return
    const data = pack(c)
    const label = c === 'upload' ? uploadedBuilt?.label ?? null : null
    const hydrated = hydrateBonds(c, label)
    const emph = hydrateEmphasis(c, label, data.pages.length)
    const list = connectionsForStrand(hydrated.connections, 0)
    const cur = list[0]
    set({
      corpus: c,
      pages: data.pages,
      connections: hydrated.connections,
      permanentBonds: hydrated.bonds,
      userBeams: hydrated.beams,
      bondLinkFromId: null,
      emphasisEdges: emph.edges,
      emphasisLinks: emph.links,
      pipelineSteps: emph.pipeline,
      emphasizeMode: false,
      emphasisStrokeActive: false,
      emphasisDraftPoints: [],
      emphasisDraftStrand: null,
      selectedEmphasisId: null,
      emphasisLinkFromId: null,
      promptReadingForId: null,
      currentStrand: 0,
      companionStrand: cur
        ? companionOf(cur, 0)
        : Math.min(1, Math.max(0, data.pages.length - 1)),
      currentConnectionId: cur?.id ?? null,
      connectionsOnCurrent: list,
      connectionCursor: 0,
      cameraDistance: readingOuterRadius(Math.max(data.pages.length, 1)),
      uploadLabel: c === 'upload' ? uploadedBuilt?.label ?? null : get().uploadLabel,
      // Drop OCR / compare state so boxes never stick on another corpus
      ocrOpen: false,
      ocrBusy: false,
      ocrError: null,
      ocrActiveStrand: null,
      ocrByStrand: {},
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
    })
    // Clear reasoning lock overlays (strand indices collide across corpora)
    void import('../reasoning/closureStore').then(({ useReasoning }) => {
      useReasoning.getState().clearActive()
    })
    if (data.pages.length > 0) triggerSwoop(set, get, 0)
  },

  setUploadProgress: (p) => set({ uploadProgress: p }),

  applyUploadedUniverse: (data) => {
    if (uploadedBuilt) revokeBlobPages(uploadedBuilt.pages)
    uploadedBuilt = data
    // 页图金库：换书清空由上传入口 / corpusPackToRuntime 负责。
    // 此处不可 clear——扫本头尾 onEdgesReady 会 apply，若清库会冲掉 emitOne 刚 stash 的图。
    // Fresh import: always start with empty annotations (ignore prior localStorage for this label).
    const list = connectionsForStrand([], 0)
    const cur = list[0]
    const importSteps: PipelineStep[] = [
      {
        id: newPipelineStepId(),
        at: Date.now(),
        kind: 'parse',
        actor: 'system',
        summary: `解析 PDF「${data.label}」`,
        detail: { pages: data.pages.length, label: data.label },
      },
      {
        id: newPipelineStepId(),
        at: Date.now() + 1,
        kind: 'render',
        actor: 'system',
        summary: `渲染 ${data.pages.length} 页为位图（jpeg）`,
        detail: { pages: data.pages.length },
      },
      {
        id: newPipelineStepId(),
        at: Date.now() + 2,
        kind: 'normalize',
        actor: 'system',
        summary: '页坐标归一到 page_norm_0_1000（选择器尺）',
        detail: { coordSpace: 'page_norm_0_1000' },
      },
    ]
    const pipelineSteps = importSteps
    set({
      corpus: 'upload',
      uploadLabel: data.label,
      uploadProgress: null,
      pages: data.pages,
      connections: [],
      permanentBonds: [],
      userBeams: [],
      bondLinkFromId: null,
      emphasisEdges: [],
      emphasisLinks: [],
      pipelineSteps,
      emphasizeMode: false,
      emphasisStrokeActive: false,
      emphasisDraftPoints: [],
      emphasisDraftStrand: null,
      selectedEmphasisId: null,
      emphasisLinkFromId: null,
      promptReadingForId: null,
      currentStrand: 0,
      companionStrand: cur
        ? companionOf(cur, 0)
        : Math.min(1, data.pages.length - 1),
      currentConnectionId: cur?.id ?? null,
      connectionsOnCurrent: list,
      connectionCursor: 0,
      cameraDistance: readingOuterRadius(Math.max(data.pages.length, 1)),
      ...(() => {
        const f = radialToYawPitch(
          pageRadialDirection(0, Math.max(data.pages.length, 1)),
        )
        return { viewYaw: f.yaw, viewPitch: f.pitch }
      })(),
      ocrOpen: false,
      ocrActiveStrand: null,
      ocrByStrand: data.ocrByStrand ?? {},
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
      letterWorkbenchMode: data.letterWorkbench === true,
      sphereAuditOpen: false,
    })
    saveEmphasisState(
      emphasisStorageKey('upload', data.label),
      [],
      [],
      pipelineSteps,
    )
    saveBondState(bondsStorageKey('upload', data.label), [], [])
    void import('../reasoning/closureStore').then(({ useReasoning }) => {
      useReasoning.getState().clearActive()
    })
    if (data.letterWorkbench !== true) {
      triggerSwoop(set, get)
    }
  },

  mergeIngestPage: (page, ocr) => {
    const strand = page.strandIndex
    set((s) => {
      const pages = s.pages.slice()
      const idx = pages.findIndex((p) => p.strandIndex === strand)
      if (idx >= 0) {
        const prev = pages[idx]!
        if (prev.imageUrl?.startsWith('blob:') && prev.imageUrl !== page.imageUrl) {
          try {
            URL.revokeObjectURL(prev.imageUrl)
          } catch {
            /* ignore */
          }
        }
        pages[idx] = page
      } else {
        pages.push(page)
        pages.sort((a, b) => a.strandIndex - b.strandIndex)
      }
      return {
        pages,
        ocrByStrand: { ...s.ocrByStrand, [strand]: ocr },
      }
    })
    // 兜底写穿：pipeline 已 stash 则跳过；文字层/其它入口只有 imageUrl 时补入库
    if (page.imageUrl && !hasPageImageInVault(strand)) {
      void imageUrlToDataUri(page.imageUrl)
        .then((dataUri) => stashPageImageDataUri(strand, dataUri))
        .catch(() => {
          /* 无图可忽略 */
        })
    }
  },

  setLetterWorkbenchMode: (on) =>
    set({
      letterWorkbenchMode: on,
      sphereAuditOpen: on ? get().sphereAuditOpen : false,
    }),

  revealSphereForAudit: () => set({ sphereAuditOpen: true }),

  hideSphereAfterAudit: () => {
    if (get().letterWorkbenchMode) {
      set({ sphereAuditOpen: false, auditSphereStrands: [] })
    }
  },

  registerAuditSphereStrand: (strandIndex) => {
    if (!Number.isFinite(strandIndex) || strandIndex < 0) return
    set((s) => {
      if (s.auditSphereStrands.includes(strandIndex)) return s
      return {
        auditSphereStrands: [...s.auditSphereStrands, strandIndex],
        settlementSphereEpoch: s.settlementSphereEpoch + 1,
      }
    })
  },

  clearAuditSphereStrands: () =>
    set((s) => ({
      auditSphereStrands: [],
      settlementSphereEpoch: s.settlementSphereEpoch + 1,
    })),

  ensurePageForAudit: async (strandIndex, opts) => {
    const focus = opts?.focus !== false
    if (!Number.isFinite(strandIndex) || strandIndex < 0) {
      return { ok: false, note: `无效 strand=${strandIndex}` }
    }

    // 缺页壳时补齐 0..strand（letter-desk 常有 bookIndex 无 3D pages）
    {
      const cur = get().pages
      const have = new Set(cur.map((p) => p.strandIndex))
      if (!have.has(strandIndex) || cur.length <= strandIndex) {
        const next = [...cur]
        const maxNeed = Math.max(
          strandIndex,
          cur.reduce((m, p) => Math.max(m, p.strandIndex), -1),
        )
        for (let i = 0; i <= maxNeed; i++) {
          if (!have.has(i)) {
            next.push({
              strandIndex: i,
              title: `p${i + 1}`,
              text: '',
              offsetMap: [],
            })
            have.add(i)
          }
        }
        next.sort((a, b) => a.strandIndex - b.strandIndex)
        set({
          pages: next,
          settlementSphereEpoch: get().settlementSphereEpoch + 1,
        })
      }
    }

    const page = get().pages.find((p) => p.strandIndex === strandIndex)
    if (!page) {
      return { ok: false, note: `无 strand=${strandIndex} 页壳` }
    }
    if (page.imageUrl) {
      if (focus) {
        set({ sphereAuditOpen: true, currentStrand: strandIndex })
      } else {
        set({ sphereAuditOpen: true })
      }
      return { ok: true, note: '页图已在内存' }
    }
    const { materializePageImageFromVault } = await import(
      '../data/pageImageVault'
    )
    const latest = get().pages.find((p) => p.strandIndex === strandIndex)
    if (latest?.imageUrl) {
      if (focus) {
        set({ sphereAuditOpen: true, currentStrand: strandIndex })
      } else {
        set({ sphereAuditOpen: true })
      }
      return { ok: true, note: '页图已在内存' }
    }
    const mat = materializePageImageFromVault(strandIndex)
    if (!mat.ok) {
      // 无金库图：仍亮球，纸页可强调；登记由调用方 registerAuditSphereStrand
      if (focus) {
        set({
          sphereAuditOpen: true,
          currentStrand: strandIndex,
          settlementSphereEpoch: get().settlementSphereEpoch + 1,
        })
      } else {
        set({
          sphereAuditOpen: true,
          settlementSphereEpoch: get().settlementSphereEpoch + 1,
        })
      }
      return { ok: false, note: mat.note }
    }
    set((s) => {
      const prev = s.pages.find((p) => p.strandIndex === strandIndex)
      const prevUrl = prev?.imageUrl
      if (prevUrl?.startsWith('blob:') && prevUrl !== mat.imageUrl) {
        try {
          URL.revokeObjectURL(prevUrl)
        } catch {
          /* ignore */
        }
      }
      return {
        pages: s.pages.map((p) =>
          p.strandIndex === strandIndex
            ? { ...p, imageUrl: mat.imageUrl }
            : p,
        ),
        sphereAuditOpen: true,
        ...(focus ? { currentStrand: strandIndex } : {}),
        settlementSphereEpoch: s.settlementSphereEpoch + 1,
      }
    })
    return { ok: true, note: `已物化 strand=${strandIndex} 页图` }
  },

  clearWorkspaceAnnotations: () => {
    const s = get()
    clearAllEmphasisStorage()
    clearAllBondStorage()
    saveEmphasisState(emphasisStorageKey(s.corpus, s.uploadLabel), [], [], [])
    saveBondState(bondsStorageKey(s.corpus, s.uploadLabel), [], [])
    set({
      emphasisEdges: [],
      emphasisLinks: [],
      pipelineSteps: [],
      permanentBonds: [],
      userBeams: [],
      connections: [],
      connectionsOnCurrent: [],
      connectionCursor: 0,
      currentConnectionId: null,
      bondLinkFromId: null,
      emphasizeMode: false,
      emphasisStrokeActive: false,
      emphasisDraftPoints: [],
      emphasisDraftStrand: null,
      selectedEmphasisId: null,
      emphasisLinkFromId: null,
      promptReadingForId: null,
      linkFocusId: null,
      overviewOpen: false,
      overviewIds: [],
      cameraLens: 'roaming',
      constructionLinkId: null,
      retrospectiveLinkId: null,
      tetrahedronCorner: null,
      tetraAnchorLinkId: null,
      tetraCandidateDId: null,
      ocrOpen: false,
      ocrActiveStrand: null,
      ocrByStrand: {},
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
    })
  },

  setEmphasizeMode: (on) => {
    // 强调笔不得单独出：与星图绑定
    get().setStarMapAndPen(on)
  },

  aimEmphasizePage: (strandIndex) => {
    const { pages, connections, emphasizeMode, currentStrand, emphasisDraftStrand } =
      get()
    if (!emphasizeMode) return
    if (strandIndex < 0 || strandIndex >= pages.length) return
    if (
      strandIndex === currentStrand &&
      emphasisDraftStrand === strandIndex
    ) {
      return
    }
    const list = connectionsForStrand(connections, strandIndex)
    const pick = list[0]
    set({
      currentStrand: strandIndex,
      connectionsOnCurrent: list,
      connectionCursor: 0,
      currentConnectionId: pick?.id ?? null,
      companionStrand: pick
        ? companionOf(pick, strandIndex)
        : get().companionStrand,
      emphasisDraftStrand: strandIndex,
      // No swoop / no viewYaw — page is prepared in place for UV-stable circling
    })
  },

  clearEmphasisDraft: () =>
    set({
      emphasisDraftPoints: [],
      emphasisStrokeActive: false,
      emphasisDraftStrand: null,
    }),

  endEmphasisStroke: () => set({ emphasisStrokeActive: false }),

  emphasisPointer: (localX, localY, phase) => {
    const { emphasizeMode } = get()
    if (!emphasizeMode) return
    const pt = localToPagePoint(localX, localY, PAGE_W, PAGE_H)

    const tryCloseFromPoints = (pts: PagePoint[]): boolean => {
      const ring = resolveClosedEmphasisRing(pts)
      if (!ring) return false
      set({ emphasisStrokeActive: false })
      get().sealEmphasisDraft(undefined, ring)
      return true
    }

    if (phase === 'down') {
      // Fresh start: left-click defines the start of the trail
      set({
        emphasisStrokeActive: true,
        emphasisDraftPoints: [pt],
      })
      return
    }

    if (phase === 'move') {
      if (!get().emphasisStrokeActive) return
      const pts = appendDrawPoint(get().emphasisDraftPoints, pt, 5)
      set({ emphasisDraftPoints: pts })
      tryCloseFromPoints(pts)
      return
    }

    // up — seal if closed (cross or near-start); else pause draft
    if (!get().emphasisStrokeActive) return
    const pts = appendDrawPoint(get().emphasisDraftPoints, pt, 5)
    if (tryCloseFromPoints(pts)) return
    set({ emphasisDraftPoints: pts, emphasisStrokeActive: false })
  },

  sealEmphasisDraft: (strandIndex, confirmedRing) => {
    const { emphasisDraftPoints, currentStrand, pages, emphasisEdges } = get()
    const target =
      strandIndex !== undefined &&
      strandIndex >= 0 &&
      strandIndex < pages.length
        ? strandIndex
        : currentStrand
    const poly =
      confirmedRing && confirmedRing.length >= 3
        ? confirmedRing
        : resolveClosedEmphasisRing(emphasisDraftPoints) ??
          (emphasisDraftPoints.length >= 3 ? emphasisDraftPoints : null)
    if (!poly || poly.length < 3) return null
    const page = pages[target]
    const now = Date.now()
    const id = newEmphasisId()
    const docId = indexDocIdFromStore(get())
    const region = makeRegionSelector(poly)
    const edge: EmphasisEdge = {
      id,
      docId,
      strandIndex: target,
      sourceDoc: page?.sourceDoc,
      sourcePage: page?.sourcePage,
      region,
      contextPolicy: 'in_situ',
      groundPolicy: 'page_minus_figure',
      reading: '',
      createdAt: now,
      updatedAt: now,
    }
    const edges = [...emphasisEdges, edge]
    set({
      emphasisEdges: edges,
      emphasisDraftPoints: [],
      emphasisDraftStrand: null,
      emphasisStrokeActive: false,
      selectedEmphasisId: id,
      currentStrand: target,
      // Keep 强调笔 on until the user closes it — browse / draw the next region
      promptReadingForId: id,
    })
    // 落笔只登记提案，不自动铸门；命中复用 / 未覆盖确认铸门见 resolveCircle + emphasizeMint
    void import('../reasoning/pageMarkStore').then(({ usePageMarkStore }) => {
      usePageMarkStore.getState().upsertEmphasizeMark({
        markId: id,
        docId,
        page: target,
        aabb: region.aabb,
        polygon: region.polygon,
        createdAt: now,
      })
    })
    pushPipeline(get, set, {
      kind: 'emphasize',
      actor: 'user',
      summary: `强调笔提案（与 layout 同级）· ${poly.length} 顶点 · 待命中或确认铸门`,
      detail: {
        emphasisId: id,
        docId,
        strandIndex: target,
        vertices: poly.length,
        sourcePage: page?.sourcePage ?? null,
        closed: true,
        closeMode: 'self_intersection',
        peer: 'layout',
        autoMint: false,
      },
    })
    persistEmphasis(get)
    return id
  },

  selectEmphasis: (id) => set({ selectedEmphasisId: id }),

  navigateToEmphasis: (id) => {
    const edge = get().emphasisEdges.find((e) => e.id === id)
    if (!edge) return false
    set({ selectedEmphasisId: id, promptReadingForId: null })
    if (edge.strandIndex !== get().currentStrand) {
      get().swoopToPage(edge.strandIndex)
    }
    return true
  },

  clearPromptReading: () => set({ promptReadingForId: null }),

  updateEmphasisReading: (id, reading) => {
    const { emphasisEdges, promptReadingForId } = get()
    const now = Date.now()
    const edges = emphasisEdges.map((e) =>
      e.id === id ? { ...e, reading, updatedAt: now } : e,
    )
    set({
      emphasisEdges: edges,
      promptReadingForId: promptReadingForId === id ? null : promptReadingForId,
    })
    pushPipeline(get, set, {
      kind: 'reading',
      actor: 'user',
      summary: `写入理解（reading）于强调 ${id.slice(0, 12)}…`,
      detail: { emphasisId: id, chars: reading.length },
    })
    persistEmphasis(get)
  },

  deleteEmphasis: (id) => {
    const {
      emphasisEdges,
      emphasisLinks,
      selectedEmphasisId,
      emphasisLinkFromId,
      promptReadingForId,
    } = get()
    const doomed = emphasisEdges.find((e) => e.id === id)
    set({
      emphasisEdges: emphasisEdges.filter((e) => e.id !== id),
      emphasisLinks: emphasisLinks.filter(
        (l) => l.fromEmphasisId !== id && l.toEmphasisId !== id,
      ),
      selectedEmphasisId: selectedEmphasisId === id ? null : selectedEmphasisId,
      emphasisLinkFromId:
        emphasisLinkFromId === id ? null : emphasisLinkFromId,
      promptReadingForId:
        promptReadingForId === id ? null : promptReadingForId,
    })
    if (doomed) {
      const docId = doomed.docId ?? indexDocIdFromStore(get())
      void import('../reasoning/pageMarkStore').then(({ usePageMarkStore }) => {
        usePageMarkStore.getState().removeMark(docId, id)
      })
    }
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: `删除强调笔划重点 ${id.slice(0, 12)}…`,
      detail: { emphasisId: id },
    })
    persistEmphasis(get)
  },

  setEmphasisLinkFrom: (id) =>
    set({
      emphasisLinkFromId: id,
      // Waiting for B: collapse workbench so 3D / board stay usable
      workbenchOpen: id ? false : get().workbenchOpen,
      // 锁 A：星图+笔必须同在（共存亡）
      starMapOpen: id ? true : get().starMapOpen,
      emphasizeMode: id ? true : get().emphasizeMode,
    }),

  createEmphasisLink: (toEmphasisId, note = '') => {
    const { emphasisLinkFromId, emphasisEdges, emphasisLinks } = get()
    if (!emphasisLinkFromId || emphasisLinkFromId === toEmphasisId) return null
    const from = emphasisEdges.find((e) => e.id === emphasisLinkFromId)
    const to = emphasisEdges.find((e) => e.id === toEmphasisId)
    if (!from || !to) return null
    const dup = emphasisLinks.some(
      (l) =>
        (l.fromEmphasisId === emphasisLinkFromId &&
          l.toEmphasisId === toEmphasisId) ||
        (l.fromEmphasisId === toEmphasisId &&
          l.toEmphasisId === emphasisLinkFromId),
    )
    if (dup) {
      set({ emphasisLinkFromId: null })
      return null
    }
    const total = Math.max(get().pages.length, 1)
    const tri = buildConstructionTriangle(from, to, total)
    const link: EmphasisLink = {
      id: newEmphasisLinkId(),
      fromEmphasisId: emphasisLinkFromId,
      toEmphasisId,
      note: note.trim(),
      apex: null,
      commentCenter: tri.c,
      createdAt: Date.now(),
    }
    set({
      emphasisLinks: [...emphasisLinks, link],
      emphasisLinkFromId: null,
      selectedEmphasisId: toEmphasisId,
    })
    get().enterConstructionLens(link.id)
    pushPipeline(get, set, {
      kind: 'link',
      actor: 'user',
      summary: `建联紫线（街面）：s${from.strandIndex} ↔ s${to.strandIndex}`,
      detail: {
        linkId: link.id,
        from: from.id,
        to: to.id,
        fromPage: from.sourcePage ?? from.strandIndex,
        toPage: to.sourcePage ?? to.strandIndex,
      },
    })
    persistEmphasis(get)
    return link.id
  },

  deleteEmphasisLink: (linkId) => {
    const s = get()
    const lensExit =
      s.constructionLinkId === linkId || s.retrospectiveLinkId === linkId
    set({
      emphasisLinks: s.emphasisLinks.filter((l) => l.id !== linkId),
      linkFocusId: s.linkFocusId === linkId ? null : s.linkFocusId,
      draggingLinkId: s.draggingLinkId === linkId ? null : s.draggingLinkId,
      ...(lensExit
        ? {
            cameraLens: 'roaming' as const,
            constructionLinkId: null,
            retrospectiveLinkId: null,
          }
        : {}),
    })
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: `删除跨强调射线 ${linkId.slice(0, 12)}…`,
      detail: { linkId },
    })
    persistEmphasis(get)
  },

  beginDragLinkApex: (linkId, initialPos) => {
    const link = get().emphasisLinks.find((l) => l.id === linkId)
    if (!link) return
    const from = get().emphasisEdges.find((e) => e.id === link.fromEmphasisId)
    const to = get().emphasisEdges.find((e) => e.id === link.toEmphasisId)
    if (!from || !to) return
    const total = get().pages.length
    const homeA = pageHomePosition(from.strandIndex, total)
    const homeB = pageHomePosition(to.strandIndex, total)
    const raw =
      initialPos ??
      link.apex ??
      defaultApexBetweenHomes(from.strandIndex, to.strandIndex, total)
    const apex = clampApexToInterlayer(raw, homeA, homeB)
    const linkApexHistory = [
      ...get().linkApexHistory,
      { linkId, apex: link.apex },
    ].slice(-40)
    set({
      draggingLinkId: linkId,
      linkFocusId: linkId,
      linkApexHistory,
      emphasisLinks: get().emphasisLinks.map((l) =>
        l.id === linkId ? { ...l, apex } : l,
      ),
      currentStrand: from.strandIndex,
      companionStrand: to.strandIndex,
      selectedEmphasisId: from.id,
      workbenchOpen: false,
    })
  },

  updateDragLinkApex: (pos) => {
    const id = get().draggingLinkId
    if (!id) return
    const link = get().emphasisLinks.find((l) => l.id === id)
    if (!link) return
    const from = get().emphasisEdges.find((e) => e.id === link.fromEmphasisId)
    const to = get().emphasisEdges.find((e) => e.id === link.toEmphasisId)
    if (!from || !to) return
    const total = get().pages.length
    const apex = clampApexToInterlayer(
      pos,
      pageHomePosition(from.strandIndex, total),
      pageHomePosition(to.strandIndex, total),
    )
    set({
      emphasisLinks: get().emphasisLinks.map((l) =>
        l.id === id ? { ...l, apex } : l,
      ),
    })
  },

  endDragLinkApex: () => {
    const id = get().draggingLinkId
    if (!id) return
    set({ draggingLinkId: null, swooping: true })
    setTimeout(() => set({ swooping: false }), 900)
    pushPipeline(get, set, {
      kind: 'link',
      actor: 'user',
      summary: `弹簧拉拽紫线并锁定新位置 ${id.slice(0, 12)}…`,
      detail: { linkId: id },
    })
    persistEmphasis(get)
  },

  clearLinkApex: (linkId) => {
    const link = get().emphasisLinks.find((l) => l.id === linkId)
    if (!link) return
    const linkApexHistory = [
      ...get().linkApexHistory,
      { linkId, apex: link.apex },
    ].slice(-40)
    set({
      linkApexHistory,
      emphasisLinks: get().emphasisLinks.map((l) =>
        l.id === linkId ? { ...l, apex: null } : l,
      ),
      linkFocusId: get().linkFocusId === linkId ? null : get().linkFocusId,
      draggingLinkId:
        get().draggingLinkId === linkId ? null : get().draggingLinkId,
      swooping: true,
    })
    setTimeout(() => set({ swooping: false }), 900)
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: `回街面顺序（清除三角簇）${linkId.slice(0, 12)}…`,
      detail: { linkId },
    })
    persistEmphasis(get)
  },

  rollbackLinkApex: () => {
    const hist = get().linkApexHistory
    if (hist.length === 0) return false
    const last = hist[hist.length - 1]
    set({
      linkApexHistory: hist.slice(0, -1),
      emphasisLinks: get().emphasisLinks.map((l) =>
        l.id === last.linkId ? { ...l, apex: last.apex } : l,
      ),
      linkFocusId: last.linkId,
      draggingLinkId: null,
      swooping: true,
    })
    setTimeout(() => set({ swooping: false }), 900)
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary: last.apex
        ? `回滚紫线至上一锁定位置 ${last.linkId.slice(0, 12)}…`
        : `回滚紫线至街面原序 ${last.linkId.slice(0, 12)}…`,
      detail: { linkId: last.linkId, restoredNull: last.apex === null },
    })
    persistEmphasis(get)
    return true
  },

  appendPipelineNote: (summary) => {
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'user',
      summary,
    })
  },

  runAiProposeAndLinkDemo: async () => {
    if (get().aiDemoRunning) return null
    const pages = get().pages
    if (pages.length < 2) {
      set({
        aiDemoStatus: '至少需要两页才能演示跨页 Agent 建联',
      })
      return null
    }

    const strandA = get().currentStrand
    let strandB = get().companionStrand
    if (strandB === strandA || strandB < 0 || strandB >= pages.length) {
      strandB = strandA === 0 ? 1 : 0
    }
    const proposal = buildDefaultAiLinkProposal(strandA, strandB)

    const animateStroke = async (p: AiEmphasisProposal) => {
      set({
        workbenchOpen: false,
        overviewOpen: false,
        emphasizeMode: true,
        // Keep strokeActive false so EmphasisOverlay shows store draft Line
        // (LiveInkTrail is GPU-only from the pen controller).
        emphasisStrokeActive: false,
        emphasisDraftStrand: p.strandIndex,
        emphasisDraftPoints: [],
        aiDemoStatus: `Agent 在第 ${p.strandIndex + 1} 页圈选 figure…`,
      })
      if (get().currentStrand !== p.strandIndex) {
        get().swoopToPage(p.strandIndex)
        await sleep(780)
      } else {
        await sleep(220)
      }
      const ring = p.polygon
      const steps = Math.max(12, Math.min(28, ring.length))
      for (let i = 1; i <= steps; i++) {
        if (!get().aiDemoRunning) return null
        const n = Math.max(2, Math.ceil((i / steps) * ring.length))
        set({
          emphasisDraftPoints: ring.slice(0, n),
          emphasisStrokeActive: false,
          emphasisDraftStrand: p.strandIndex,
          emphasizeMode: true,
        })
        await sleep(36)
      }
      set({
        emphasisDraftPoints: [...ring, ring[0]],
        emphasisStrokeActive: false,
      })
      await sleep(220)
      const id = get().sealEmphasisDraft(p.strandIndex, ring)
      if (id && p.reading.trim()) {
        get().updateEmphasisReading(id, p.reading)
      }
      return id
    }

    set({
      aiDemoRunning: true,
      aiDemoStatus: 'Agent 开始：提议两处强调并建联',
      cameraLens: 'roaming',
      constructionLinkId: null,
      cameraEye: null,
      cameraLookAt: null,
    })
    pushPipeline(get, set, {
      kind: 'note',
      actor: 'system',
      summary: 'Agent demo：提议两处 figure 圈注并跨页建联',
      detail: { strandA, strandB },
    })

    try {
      const fromId = await animateStroke(proposal.from)
      if (!fromId) {
        set({
          aiDemoRunning: false,
          aiDemoStatus: 'Agent 圈选 A 失败',
          emphasizeMode: false,
          emphasisDraftPoints: [],
          emphasisStrokeActive: false,
        })
        return null
      }
      await sleep(350)
      const toId = await animateStroke(proposal.to)
      if (!toId) {
        set({
          aiDemoRunning: false,
          aiDemoStatus: 'Agent 圈选 B 失败',
          emphasizeMode: false,
          emphasisDraftPoints: [],
          emphasisStrokeActive: false,
        })
        return null
      }

      set({
        aiDemoStatus: 'Agent 建联 A↔B → 进入构建镜头',
        emphasizeMode: false,
        emphasisDraftPoints: [],
        emphasisDraftStrand: null,
        lastAgentHitIds: [fromId, toId],
      })
      await sleep(280)
      get().setEmphasisLinkFrom(fromId)
      const linkId = get().createEmphasisLink(toId, proposal.note)
      if (!linkId) {
        set({
          aiDemoRunning: false,
          aiDemoStatus: '建联失败（可能已存在相同射线）',
        })
        return null
      }
      set({
        aiDemoRunning: false,
        aiDemoStatus: '完成：两处 Agent 强调 + 紫线 + 构建镜头',
        promptReadingForId: null,
      })
      return { fromId, toId, linkId }
    } catch (e) {
      set({
        aiDemoRunning: false,
        aiDemoStatus: e instanceof Error ? e.message : String(e),
        emphasizeMode: false,
        emphasisStrokeActive: false,
        emphasisDraftPoints: [],
      })
      return null
    }
  },

  runOcrOnCurrentPage: async (opts) => {
    const { currentStrand, pages, ocrByStrand } = get()
    const page = pages[currentStrand]
    if (!page) return

    const force = opts?.force === true
    const existing = ocrByStrand[currentStrand]
    if (existing && !force) {
      set({
        ocrOpen: true,
        ocrActiveStrand: currentStrand,
        ocrError: null,
        ocrHoverBlock: null,
        ocrEditingBlockId: null,
        ocrInlineEdit: false,
        cameraDistance: Math.max(
          get().cameraDistance,
          readingOuterRadius(Math.max(pages.length, 1)),
        ),
      })
      return
    }

    if (existing && force && ocrPageHasEdits(existing)) {
      const ok = window.confirm(
        '重新识别会按「切割即登记」重跑（geom→crop→T），覆盖本页 OCR 文本修改；AABB 与 T0 重新排放。继续？',
      )
      if (!ok) return
    }

    if (!page.imageUrl) {
      set({
        ocrError: '当前页没有图像，无法 OCR（请先上传带页图的 PDF）',
        ocrOpen: false,
      })
      return
    }

    set({
      ocrBusy: true,
      ocrError: null,
      ocrOpen: true,
      ocrActiveStrand: currentStrand,
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
      cameraDistance: Math.max(
        get().cameraDistance,
        readingOuterRadius(Math.max(pages.length, 1)),
      ),
    })

    try {
      const dataUri = await imageUrlToDataUri(page.imageUrl)
      stashPageImageDataUri(currentStrand, dataUri)
      const docId = indexDocIdFromStore(get())
      const result = await emitPageViaProtocol({
        docId,
        page: currentStrand,
        strandIndex: currentStrand,
        imageDataUri: dataUri,
      })
      set({
        ocrByStrand: { ...get().ocrByStrand, [currentStrand]: result },
        ocrBusy: false,
        ocrOpen: true,
        ocrActiveStrand: currentStrand,
      })
      pushPipeline(get, set, {
        kind: 'ocr',
        actor: 'system',
        summary: `协议排放 OCR s${currentStrand} → ${result.blocks.length} 槽（服务端铸键）`,
        detail: {
          strandIndex: currentStrand,
          blocks: result.blocks.length,
          cutBound: result.blocks.filter((b) => b.cutBound).length,
          via: 'protocol/emit-page',
        },
      })
      try {
        await syncIndexPages([currentStrand])
      } catch (syncErr) {
        const syncMsg =
          syncErr instanceof Error ? syncErr.message : String(syncErr)
        set({
          ocrError: `OCR 已完成，但索引同步失败：${syncMsg}`,
        })
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'OCR 失败'
      set({ ocrBusy: false, ocrError: msg, ocrOpen: true })
    }
  },

  runOcrOnPagesLackingText: async (opts) => {
    const { pages, ocrByStrand } = get()
    const maxPages = opts?.maxPages ?? 40
    const concurrency = Math.max(1, opts?.concurrency ?? 3)
    const forceEvenIfPdfText = opts?.forceEvenIfPdfText === true
    const targets = pages
      .filter((p) => {
        if (!p.imageUrl) return false
        if (ocrByStrand[p.strandIndex]) return false
        if (!forceEvenIfPdfText) {
          const chunks = p.textChunks
          if (chunks && chunks.length > 0) return false
        }
        return true
      })
      .slice(0, maxPages)

    if (targets.length === 0) {
      return { done: 0, failed: 0 }
    }

    set({
      ocrBusy: true,
      ocrError: null,
      ocrOpen: true,
      ocrActiveStrand: targets[0].strandIndex,
    })

    const { runBatchesParallel } = await import('../arch/parallelLlmBatch')
    let done = 0
    let failed = 0
    let finished = 0
    const succeededPages: number[] = []

    await runBatchesParallel({
      batches: targets,
      concurrency,
      run: async (page) => {
        if (!page.imageUrl) throw new Error('无图像')
        const dataUri = await imageUrlToDataUri(page.imageUrl)
        stashPageImageDataUri(page.strandIndex, dataUri)
        const docId = indexDocIdFromStore(get())
        const result = await emitPageViaProtocol({
          docId,
          page: page.strandIndex,
          strandIndex: page.strandIndex,
          imageDataUri: dataUri,
        })
        set({
          ocrByStrand: {
            ...get().ocrByStrand,
            [page.strandIndex]: result,
          },
          ocrActiveStrand: page.strandIndex,
        })
        done += 1
        succeededPages.push(page.strandIndex)
        finished += 1
        opts?.onProgress?.(finished, targets.length, page.strandIndex)
        pushPipeline(get, set, {
          kind: 'ocr',
          actor: 'system',
          summary: `协议排放 OCR s${page.strandIndex} → ${result.blocks.length} 槽`,
          detail: {
            strandIndex: page.strandIndex,
            blocks: result.blocks.length,
            cutBound: result.blocks.filter((b) => b.cutBound).length,
            via: 'protocol/emit-page',
          },
        })
        return result
      },
    }).then((parallel) => {
      for (const r of parallel.results) {
        if (r.ok) continue
        failed += 1
        finished += 1
        const strand = targets[r.index]?.strandIndex ?? r.index
        opts?.onProgress?.(finished, targets.length, strand)
        set({
          ocrError: `页 s${strand}: ${r.aborted ? '已取消' : r.note}`,
        })
      }
    })

    set({ ocrBusy: false })
    opts?.onProgress?.(
      targets.length,
      targets.length,
      targets[targets.length - 1].strandIndex,
    )

    if (!opts?.deferIndexSync && succeededPages.length > 0) {
      try {
        await syncIndexPages(succeededPages)
      } catch (syncErr) {
        const syncMsg =
          syncErr instanceof Error ? syncErr.message : String(syncErr)
        set({
          ocrError: `部分 OCR 已完成，索引同步失败：${syncMsg}`,
        })
      }
    }

    return { done, failed }
  },

  closeOcrPanel: () => {
    set({
      ocrOpen: false,
      ocrActiveStrand: null,
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
      ocrError: null,
    })
  },

  setOcrHoverBlock: (id) => set({ ocrHoverBlock: id }),

  setOcrEditingBlockId: (id) =>
    set({ ocrEditingBlockId: id, ocrHoverBlock: id, ocrInlineEdit: false }),

  beginOcrInlineEdit: (id) =>
    set({ ocrEditingBlockId: id, ocrHoverBlock: id, ocrInlineEdit: true }),

  endOcrInlineEdit: () =>
    set({ ocrEditingBlockId: null, ocrInlineEdit: false }),

  updateOcrBlockContent: (blockId, content) => {
    const { ocrActiveStrand, ocrByStrand } = get()
    if (ocrActiveStrand === null) return
    const page = ocrByStrand[ocrActiveStrand]
    if (!page) return
    const blocks = page.blocks.map((b) =>
      b.id === blockId
        ? {
            ...b,
            content,
            // Text changed → must re-verify before sealing a bond
            confirmed: content === b.content ? b.confirmed : false,
          }
        : b,
    )
    set({
      ocrByStrand: {
        ...ocrByStrand,
        [ocrActiveStrand]: {
          ...page,
          blocks,
          markdown: rebuildOcrMarkdown(blocks),
        },
      },
    })
  },

  restoreOcrBlockContent: (blockId) => {
    const { ocrActiveStrand, ocrByStrand } = get()
    if (ocrActiveStrand === null) return
    const page = ocrByStrand[ocrActiveStrand]
    if (!page) return
    const blocks = page.blocks.map((b) =>
      b.id === blockId
        ? {
            ...b,
            content: b.sourceContent,
            confirmed:
              b.content === b.sourceContent ? b.confirmed : false,
          }
        : b,
    )
    set({
      ocrByStrand: {
        ...ocrByStrand,
        [ocrActiveStrand]: {
          ...page,
          blocks,
          markdown: rebuildOcrMarkdown(blocks),
        },
      },
    })
  },

  confirmOcrBlock: (blockId) => {
    const { ocrActiveStrand, ocrByStrand } = get()
    if (ocrActiveStrand === null) return
    const page = ocrByStrand[ocrActiveStrand]
    if (!page) return
    const target = page.blocks.find((b) => b.id === blockId)
    if (!target || !target.content.trim()) return
    const blocks = page.blocks.map((b) =>
      b.id === blockId ? { ...b, confirmed: true } : b,
    )
    set({
      ocrByStrand: {
        ...ocrByStrand,
        [ocrActiveStrand]: {
          ...page,
          blocks,
          markdown: rebuildOcrMarkdown(blocks),
        },
      },
      ocrEditingBlockId: blockId,
      ocrHoverBlock: blockId,
    })
    void syncIndexAtomText(blockId, target.content, ocrActiveStrand).catch(
      (syncErr: unknown) => {
        const syncMsg =
          syncErr instanceof Error ? syncErr.message : String(syncErr)
        set({ ocrError: `已确认，但索引 T 同步失败：${syncMsg}` })
      },
    )
  },

  deleteOcrBlock: (blockId) => {
    const { ocrActiveStrand, ocrByStrand, ocrEditingBlockId, ocrHoverBlock } =
      get()
    if (ocrActiveStrand === null) return
    const page = ocrByStrand[ocrActiveStrand]
    if (!page) return
    const blocks = page.blocks.filter((b) => b.id !== blockId)
    set({
      ocrByStrand: {
        ...ocrByStrand,
        [ocrActiveStrand]: {
          ...page,
          blocks,
          markdown: rebuildOcrMarkdown(blocks),
        },
      },
      ocrEditingBlockId: ocrEditingBlockId === blockId ? null : ocrEditingBlockId,
      ocrHoverBlock: ocrHoverBlock === blockId ? null : ocrHoverBlock,
      ocrInlineEdit:
        ocrEditingBlockId === blockId ? false : get().ocrInlineEdit,
    })
    void syncIndexPages([ocrActiveStrand]).catch((syncErr: unknown) => {
      const syncMsg =
        syncErr instanceof Error ? syncErr.message : String(syncErr)
      set({ ocrError: `切块已删，但索引同步失败：${syncMsg}` })
    })
  },

  addOcrBlock: (opts) => {
    const { ocrActiveStrand, ocrByStrand } = get()
    if (ocrActiveStrand === null) return null
    const page = ocrByStrand[ocrActiveStrand]
    if (!page) return null
    const id = newOcrBlockId()
    const content = opts?.content ?? ''
    const bbox = opts?.bbox ?? ([120, 420, 880, 500] as [
      number,
      number,
      number,
      number,
    ])
    const block: OcrBlock = {
      id,
      index: page.blocks.length,
      label: opts?.label ?? 'text',
      content,
      sourceContent: content,
      bbox,
      confirmed: false,
    }
    const blocks = [...page.blocks, block]
    set({
      ocrByStrand: {
        ...ocrByStrand,
        [ocrActiveStrand]: {
          ...page,
          blocks,
          markdown: rebuildOcrMarkdown(blocks),
        },
      },
      ocrEditingBlockId: id,
      ocrHoverBlock: id,
      ocrInlineEdit: true,
    })
    return id
  },

  addOcrBlockAtLocalPoint: (localX, localY) => {
    const bbox = localPointToBbox(localX, localY, PAGE_W, PAGE_H)
    return get().addOcrBlock({
      content: '',
      bbox,
      label: 'text',
    })
  },

  sealPermanentBond: ({ ocrBlockId, comment }) => {
    const { ocrActiveStrand, ocrByStrand, permanentBonds, userBeams } = get()
    if (ocrActiveStrand === null) return null
    const page = ocrByStrand[ocrActiveStrand]
    if (!page) return null
    const block = page.blocks.find((b) => b.id === ocrBlockId)
    if (!block || !block.confirmed || !block.content.trim()) return null
    const trimmed = comment.trim()
    if (!trimmed) return null
    const now = Date.now()
    const id = newBondId()
    // cutBound emit：block.id 即 sealed bookKey（layout 门）；人手加框则无
    const bookKey =
      typeof block.id === 'string' && block.id.startsWith('h1.')
        ? block.id
        : undefined
    const bond: PermanentBond = {
      id,
      strandIndex: ocrActiveStrand,
      bbox: [...block.bbox] as [number, number, number, number],
      ocrBlockId: block.id,
      confirmedText: block.content,
      comment: trimmed,
      bookKey,
      createdAt: now,
      updatedAt: now,
    }
    applyBondGraph(set, get, [...permanentBonds, bond], userBeams)
    return id
  },

  sealAttentionBond: ({
    strandIndex,
    bbox,
    confirmedText,
    comment,
    bookKey,
    briefKey,
  }) => {
    const { permanentBonds, userBeams } = get()
    const now = Date.now()
    const text = confirmedText.trim() || bookKey
    const note = comment.trim() || briefKey
    const existing = permanentBonds.find(
      (b) => b.bookKey === bookKey || (b.briefKey && b.briefKey === briefKey),
    )
    if (existing) {
      const bonds = permanentBonds.map((b) =>
        b.id === existing.id
          ? {
              ...b,
              strandIndex,
              bbox: [...bbox] as [number, number, number, number],
              confirmedText: text,
              comment: note,
              bookKey,
              briefKey,
              updatedAt: now,
            }
          : b,
      )
      applyBondGraph(set, get, bonds, userBeams)
      return existing.id
    }
    const id = newBondId()
    const bond: PermanentBond = {
      id,
      strandIndex,
      bbox: [...bbox] as [number, number, number, number],
      ocrBlockId: `attn_${bookKey}`,
      confirmedText: text,
      comment: note,
      bookKey,
      briefKey,
      createdAt: now,
      updatedAt: now,
    }
    applyBondGraph(set, get, [...permanentBonds, bond], userBeams)
    return id
  },

  updateBondComment: (bondId, comment) => {
    const { permanentBonds, userBeams } = get()
    const trimmed = comment.trim()
    if (!trimmed) return
    const now = Date.now()
    const bonds = permanentBonds.map((b) =>
      b.id === bondId ? { ...b, comment: trimmed, updatedAt: now } : b,
    )
    applyBondGraph(set, get, bonds, userBeams)
  },

  deletePermanentBond: (bondId) => {
    const { permanentBonds, userBeams, bondLinkFromId } = get()
    const bonds = permanentBonds.filter((b) => b.id !== bondId)
    const beams = userBeams.filter(
      (b) => b.fromBondId !== bondId && b.toBondId !== bondId,
    )
    applyBondGraph(set, get, bonds, beams, {
      bondLinkFromId: bondLinkFromId === bondId ? null : bondLinkFromId,
    })
  },

  setBondLinkFrom: (bondId) => set({ bondLinkFromId: bondId }),

  createUserBeam: (toBondId, flinkType = 'pointer') => {
    const { bondLinkFromId, permanentBonds, userBeams } = get()
    if (!bondLinkFromId || bondLinkFromId === toBondId) return null
    const from = permanentBonds.find((b) => b.id === bondLinkFromId)
    const to = permanentBonds.find((b) => b.id === toBondId)
    if (!from || !to) return null
    const dup = userBeams.some(
      (b) =>
        (b.fromBondId === bondLinkFromId && b.toBondId === toBondId) ||
        (b.fromBondId === toBondId && b.toBondId === bondLinkFromId),
    )
    if (dup) {
      set({ bondLinkFromId: null })
      return null
    }
    const beam: UserBeam = {
      id: newBeamId(),
      fromBondId: bondLinkFromId,
      toBondId,
      flinkType,
      createdAt: Date.now(),
    }
    applyBondGraph(set, get, permanentBonds, [...userBeams, beam], {
      bondLinkFromId: null,
    })
    return beam.id
  },

  deleteUserBeam: (beamId) => {
    const { permanentBonds, userBeams } = get()
    applyBondGraph(
      set,
      get,
      permanentBonds,
      userBeams.filter((b) => b.id !== beamId),
    )
  },

  refreshConnectionsOnCurrent: () => {
    const { connections, currentStrand, currentConnectionId } = get()
    const list = connectionsForStrand(connections, currentStrand)
    let cursor = list.findIndex((c) => c.id === currentConnectionId)
    if (cursor < 0) cursor = 0
    const cur = list[cursor]
    set({
      connectionsOnCurrent: list,
      connectionCursor: cursor,
      currentConnectionId: cur?.id ?? null,
      companionStrand: cur ? companionOf(cur, currentStrand) : get().companionStrand,
    })
  },

  selectConnection: (id) => {
    const { connectionsOnCurrent, currentStrand } = get()
    const cursor = connectionsOnCurrent.findIndex((c) => c.id === id)
    if (cursor < 0) return
    const cur = connectionsOnCurrent[cursor]
    set({
      connectionCursor: cursor,
      currentConnectionId: id,
      companionStrand: companionOf(cur, currentStrand),
    })
    triggerSwoop(set, get)
  },

  stepConnection: (dir) => {
    const { connectionsOnCurrent, connectionCursor, currentStrand } = get()
    if (connectionsOnCurrent.length === 0) return
    const next =
      (connectionCursor + dir + connectionsOnCurrent.length) %
      connectionsOnCurrent.length
    const cur = connectionsOnCurrent[next]
    set({
      connectionCursor: next,
      currentConnectionId: cur.id,
      companionStrand: companionOf(cur, currentStrand),
    })
    triggerSwoop(set, get)
  },

  flipToCompanion: () => {
    const { companionStrand, currentStrand, currentConnectionId, connections } =
      get()
    if (companionStrand === currentStrand) return
    const prevCurrent = currentStrand
    set({ currentStrand: companionStrand, ocrOpen: false, ocrActiveStrand: null })
    get().refreshConnectionsOnCurrent()
    const still = currentConnectionId
      ? connections.find((c) => c.id === currentConnectionId)
      : undefined
    set({
      companionStrand: still
        ? companionOf(still, companionStrand)
        : prevCurrent,
    })
    triggerSwoop(set, get)
  },

  swapPages: () => {
    const { currentStrand, companionStrand } = get()
    set({
      currentStrand: companionStrand,
      companionStrand: currentStrand,
      ocrOpen: false,
      ocrActiveStrand: null,
    })
    get().refreshConnectionsOnCurrent()
    triggerSwoop(set, get)
  },

  swoopAlongCurrent: () => {
    get().flipToCompanion()
  },

  traverseAlongPair: (strandA, strandB, opts) => {
    if (strandA === strandB) return
    const { pages, connections, currentStrand } = get()
    const total = pages.length
    if (
      strandA < 0 ||
      strandB < 0 ||
      strandA >= total ||
      strandB >= total
    ) {
      return
    }

    /**
     * Always land on a destination page of this beam:
     * - already on one end → fly to the other (Nelson follow)
     * - on neither → fly to A, companion B (step onto the link)
     */
    let nextCurrent: number
    let nextCompanion: number
    if (currentStrand === strandA) {
      nextCurrent = strandB
      nextCompanion = strandA
    } else if (currentStrand === strandB) {
      nextCurrent = strandA
      nextCompanion = strandB
    } else {
      nextCurrent = strandA
      nextCompanion = strandB
    }

    const list = connectionsForStrand(connections, nextCurrent)
    const connectionId = opts?.connectionId ?? null
    let cursor = connectionId
      ? list.findIndex((c) => c.id === connectionId)
      : -1
    if (cursor < 0) {
      cursor = list.findIndex(
        (c) =>
          (c.fromStrand === nextCompanion && c.toStrand === nextCurrent) ||
          (c.toStrand === nextCompanion && c.fromStrand === nextCurrent),
      )
    }
    if (cursor < 0) cursor = 0
    const pick = list[cursor]
    const resolvedConnectionId = connectionId ?? pick?.id ?? null

    let selectedEmphasis: string | null = get().selectedEmphasisId
    if (opts?.emphasisFromId && opts?.emphasisToId) {
      selectedEmphasis =
        nextCurrent === strandA ? opts.emphasisFromId : opts.emphasisToId
    }

    const dist = framingDistanceForPair(
      nextCurrent,
      nextCompanion,
      total,
      get().cameraDistance,
    )
    const mid = pageRadialDirection(nextCurrent, total)
      .clone()
      .add(pageRadialDirection(nextCompanion, total))
    const face =
      mid.lengthSq() < 1e-8
        ? radialToYawPitch(pageRadialDirection(nextCurrent, total))
        : radialToYawPitch(mid.normalize())

    set({
      currentStrand: nextCurrent,
      companionStrand: nextCompanion,
      connectionsOnCurrent: list,
      connectionCursor: pick ? cursor : 0,
      currentConnectionId: resolvedConnectionId,
      selectedEmphasisId: selectedEmphasis,
      cameraDistance: dist,
      viewYaw: face.yaw,
      viewPitch: face.pitch,
      viewPan: [0, 0, 0],
      swooping: true,
      ocrOpen: false,
      ocrActiveStrand: null,
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
    })
    setTimeout(() => set({ swooping: false }), 1200)
  },

  swoopToPage: (strandIndex) => {
    const { pages, currentStrand, connections } = get()
    if (
      strandIndex < 0 ||
      strandIndex >= pages.length ||
      strandIndex === currentStrand
    ) {
      return
    }
    const prev = currentStrand
    const list = connectionsForStrand(connections, strandIndex)
    const back = list.find(
      (c) => c.fromStrand === prev || c.toStrand === prev,
    )
    const pick = back ?? list[0]
    set({
      currentStrand: strandIndex,
      connectionsOnCurrent: list,
      connectionCursor: pick ? list.indexOf(pick) : 0,
      currentConnectionId: pick?.id ?? null,
      companionStrand: pick ? companionOf(pick, strandIndex) : prev,
      ocrOpen: false,
      ocrActiveStrand: null,
      ocrHoverBlock: null,
      ocrEditingBlockId: null,
      ocrInlineEdit: false,
    })
    triggerSwoop(set, get, strandIndex)
  },

  stepPage: (dir) => {
    const { pages, currentStrand } = get()
    if (pages.length === 0) return
    const next = (currentStrand + dir + pages.length) % pages.length
    get().swoopToPage(next)
  },

  followCurrentConnection: () => {
    get().flipToCompanion()
  },

  // Outer-shell radius; clamped against inner sphere in OrbitControlsProxy too
  setCameraDistance: (d) => {
    const total = Math.max(get().pages.length, 1)
    const inner = innerSphereRadius(total)
    set({
      cameraDistance: Math.min(inner * 5 + 80, Math.max(inner + 3, d)),
    })
  },

  panView: (delta) =>
    set((s) => ({
      viewPan: [
        s.viewPan[0] + delta[0],
        s.viewPan[1] + delta[1],
        s.viewPan[2] + delta[2],
      ],
    })),

  resetViewPan: () => set({ viewPan: [0, 0, 0] }),

  // Slide on outer sphere; pitch kept in (-π/2, π/2) so up-vector stays stable.
  // Construction / retrospective use panConstructionView (image-plane truck), not orbit.
  orbit: (dyaw, dpitch) =>
    set((s) => {
      if (
        s.cameraLens === 'construction' ||
        s.cameraLens === 'retrospective'
      ) {
        return {}
      }
      const lim = Math.PI / 2 - 0.04
      const clearingLook =
        s.cameraLookAt !== null ||
        s.cameraEye !== null ||
        s.cameraLens === 'tetrahedron'
      return {
        viewYaw: s.viewYaw + dyaw,
        viewPitch: Math.max(-lim, Math.min(lim, s.viewPitch + dpitch)),
        ...(clearingLook
          ? {
              cameraLookAt: null,
              cameraEye: null,
              cameraLens: 'roaming' as const,
              tetrahedronCorner: null,
              tetraAnchorLinkId: null,
            }
          : {}),
      }
    }),

  commitViewKeyframe: (opts) => {
    const s = get()
    if (s.viewPathMode !== 'live' || s.cameraLens !== 'roaming') return
    const pose = {
      yaw: s.viewYaw,
      pitch: s.viewPitch,
      distance: s.cameraDistance,
    }
    const tag = opts?.tag ?? '打点'
    const viewPath = appendKeyframe(s.viewPath, pose, tag, {
      force: opts?.force,
    })
    if (viewPath === s.viewPath) return
    set({
      viewPath,
      viewPathCursor: viewPath.length - 1,
    })
  },

  playViewPath: () => {
    const { viewPath, viewPathCursor } = get()
    if (viewPath.length < 2) {
      if (viewPath.length === 1) {
        const f = viewPath[0]
        set({
          viewPathMode: 'paused',
          viewYaw: f.yaw,
          viewPitch: f.pitch,
          cameraDistance: f.distance,
          viewPathCursor: 0,
        })
      }
      return
    }
    const cursor =
      viewPathCursor >= viewPath.length - 1 ? 0 : viewPathCursor
    const pose = sampleViewPath(viewPath, cursor)
    set({
      viewPathMode: 'playing',
      viewPathCursor: cursor,
      ...(pose
        ? {
            viewYaw: pose.yaw,
            viewPitch: pose.pitch,
            cameraDistance: pose.distance,
          }
        : {}),
    })
  },

  pauseViewPath: () => {
    if (get().viewPath.length === 0) return
    set({ viewPathMode: 'paused' })
  },

  liveViewPath: () => {
    set({
      viewPathMode: 'live',
      viewPathSelectA: null,
      viewPathSelectB: null,
    })
  },

  setViewPathCursor: (cursor) => {
    const { viewPath } = get()
    if (viewPath.length === 0) return
    const max = viewPath.length - 1
    const c = Math.min(max, Math.max(0, cursor))
    const pose = sampleViewPath(viewPath, c)
    set({
      viewPathCursor: c,
      viewPathMode: 'paused',
      ...(pose
        ? {
            viewYaw: pose.yaw,
            viewPitch: pose.pitch,
            cameraDistance: pose.distance,
          }
        : {}),
    })
  },

  tickViewPathPlayback: (dt) => {
    const s = get()
    if (s.viewPathMode !== 'playing' || s.viewPath.length < 2) return
    // ~2.5 keyframes per second along the path
    const speed = 2.5
    let next = s.viewPathCursor + dt * speed
    const max = s.viewPath.length - 1
    if (next >= max) {
      next = max
      const pose = sampleViewPath(s.viewPath, next)
      set({
        viewPathCursor: next,
        viewPathMode: 'paused',
        ...(pose
          ? {
              viewYaw: pose.yaw,
              viewPitch: pose.pitch,
              cameraDistance: pose.distance,
            }
          : {}),
      })
      return
    }
    const pose = sampleViewPath(s.viewPath, next)
    set({
      viewPathCursor: next,
      ...(pose
        ? {
            viewYaw: pose.yaw,
            viewPitch: pose.pitch,
            cameraDistance: pose.distance,
          }
        : {}),
    })
  },

  deleteViewPathFrameAt: (index) => {
    const { viewPath, viewPathCursor } = get()
    if (index < 0 || index >= viewPath.length) return
    const next = viewPath.filter((_, i) => i !== index)
    const cursor = Math.min(
      next.length === 0 ? 0 : next.length - 1,
      Math.max(0, viewPathCursor >= index ? viewPathCursor - 1 : viewPathCursor),
    )
    const pose = sampleViewPath(next, cursor)
    set({
      viewPath: next,
      viewPathCursor: cursor,
      viewPathSelectA: null,
      viewPathSelectB: null,
      viewPathMode: next.length === 0 ? 'live' : 'paused',
      ...(pose
        ? {
            viewYaw: pose.yaw,
            viewPitch: pose.pitch,
            cameraDistance: pose.distance,
          }
        : {}),
    })
  },

  deleteViewPathSelection: () => {
    const { viewPath, viewPathSelectA, viewPathSelectB, viewPathCursor } = get()
    if (viewPathSelectA === null) return
    const b = viewPathSelectB ?? viewPathSelectA
    const lo = Math.min(viewPathSelectA, b)
    const hi = Math.max(viewPathSelectA, b)
    const next = viewPath.filter((_, i) => i < lo || i > hi)
    const cursor = Math.min(
      next.length === 0 ? 0 : next.length - 1,
      lo > 0 ? lo - 1 : 0,
    )
    const pose = sampleViewPath(next, cursor)
    set({
      viewPath: next,
      viewPathCursor: Math.min(cursor, Math.max(0, next.length - 1)),
      viewPathSelectA: null,
      viewPathSelectB: null,
      viewPathMode: next.length === 0 ? 'live' : 'paused',
      ...(pose
        ? {
            viewYaw: pose.yaw,
            viewPitch: pose.pitch,
            cameraDistance: pose.distance,
          }
        : {}),
    })
    void viewPathCursor
  },

  setViewPathSelectMark: (index) => {
    const { viewPathSelectA, viewPathSelectB } = get()
    if (viewPathSelectA === null || viewPathSelectB !== null) {
      set({ viewPathSelectA: index, viewPathSelectB: null })
      return
    }
    set({ viewPathSelectB: index })
  },

  clearViewPathSelection: () =>
    set({ viewPathSelectA: null, viewPathSelectB: null }),

  clearViewPath: () =>
    set({
      viewPath: [],
      viewPathCursor: 0,
      viewPathMode: 'live',
      viewPathSelectA: null,
      viewPathSelectB: null,
    }),
}))
