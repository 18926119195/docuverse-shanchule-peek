export type {
  AChunkSource,
  ActionKind,
  ActionRecord,
  AdjustKind,
  DialogueClosure,
  DirectionRecord,
  FanoutPath,
  FigFace,
  InstructionBundle,
  IntrinsicCoordinate,
  LinkType,
  LlmCallResult,
  LockBox,
  PlaceFaces,
  PlaceKind,
  ReasonEdge,
  RelationKind,
  TextFace,
} from './types'
export {
  classifyIntervalRelation,
  facesToReadout,
  formatRLabel,
  makeComboKey,
  makeFigKey,
  makeIntrinsicKey,
  makeSlotKey,
  stableShortHash,
} from './intrinsicKey'
export {
  fullSlotMember,
  spanToPct,
} from './ocrSlot'
export type { SlotMemberRef } from './ocrSlot'
export { textToProbe, cosine } from './lexicalProbe'
export { buildInferBundle, bundleToPrompt } from './bundle'
export { callLlmWithBundle, llmConfigStatus } from './llmClient'
export { useReasoning } from './closureStore'
export { useFanout } from './fanoutStore'
export type { FanoutPhase } from './fanoutStore'
export {
  runFanout,
  prepareLetterDesk,
  executeLetterDesk,
  reproposeLetterDesk,
  setLetterUnitDecision,
  rebuildLetterDeskWithLock,
  relockCorridorOnDesk,
} from './fanoutRunner'
export type {
  FanoutDraftReport,
  FanoutRunOptions,
  FanoutRunResult,
  LetterDeskSession,
} from './fanoutRunner'
export { unitFromMemberKeys } from './fanoutCompose'
export type { FanoutInferUnit, FanoutUnitKind } from './fanoutCompose'
export {
  buildPathMarker,
  proposeLetterRows,
  strategyLabel,
} from './letterDesk'
export type {
  DeferredUnitArchive,
  LetterDeskSnapshot,
  LetterRunStrategy,
  LetterUnitDecision,
  LetterUnitRow,
} from './letterDesk'
export {
  buildFingerprint,
  recommendToolClasses,
  findReusablePath,
  collectRefluxMarkers,
} from './toolArchive'
export type { ToolClass, ToolRecommend, ReuseHit } from './toolArchive'
export {
  emptyCurrentObject,
  lockSlotsObject,
  filterKeysByObject,
} from './currentObject'
export type { CurrentObject, ObjectScopeKind } from './currentObject'
export { resolveLineage } from './lineage'
export type { LineageNode } from './lineage'
export {
  executeCompose,
  executeInferOps,
  executeRetrieve,
  executeReuse,
  memberKeysSignature,
} from './toolGateway'
export {
  aabbIoU,
  appendConfirmedLayoutSlotFromEmphasize,
  buildBookIndex,
  candidateFromReusePieces,
  decomposeEmphasizeAgainstLayout,
  intersectEmphasizeWithLayout,
  isFigLayoutLabel,
  nextLayoutKOnPage,
  patchAtomTextInBookIndex,
  rebuildPagesInBookIndex,
  reembedBookIndex,
  resolveCircleToR,
  resolveVqToCandidates,
  sealEmphasizeRegionKey,
} from './pipelineA'
export type { BookIndex, CircleCandidate, CircleResolveResult } from './pipelineA'
export { clearBookIndex, loadBookIndex, saveBookIndex } from './bookIndexStore'
export {
  defaultDualModelConfig,
  dualModelStatus,
  loadDualModelConfig,
  LOCKED_LLM,
  ocrEndpointReady,
  saveDualModelConfig,
} from './modelRuntimeConfig'
export type { DualModelConfig, ModelSlotConfig } from './modelRuntimeConfig'
export { useIndexGate } from './indexGate'
export type { IndexPhase } from './indexGate'
export { usePageMarkStore } from './pageMarkStore'
export {
  confirmEmphasizeMintBookKey,
  confirmPendingEmphasizeMint,
} from './emphasizeMint'
export { usePanelEmphasizeStore } from './panelEmphasizeStore'
export type { PanelEmphasizeStroke } from './panelEmphasizeStore'
export {
  bookKeyHostWorld,
  inferAttentionKeyKind,
  resolveKeyWorldAnchor,
  resolveKeyAnchorPair,
} from './keyWorldAnchor'
export type { KeyAnchorResolve } from './keyWorldAnchor'
export { usePanelSummonStore } from './panelSummonStore'
export type { SummonedPanel } from './panelSummonStore'
export { SHELL_STEP_MIN, SHELL_STEP_MAX } from './panelSummonStore'
export {
  buildTurnJobGraph,
  resolveActiveQueryKey,
  adjacentCallIdsForKey,
  memberKeysForLlmCall,
} from './turnJobProgress'
export type {
  TurnJobGraph,
  TurnJobNode,
  TurnJobEdge,
} from './turnJobProgress'
export type { LlmCallLedgerEntry } from './llmCallLedger'
export {
  packAdjacentShellRatios,
  adjacentRatioForKind,
  ADJACENT_SHELL_STEP,
  KEY_KIND_EDGES,
  KEY_KIND_ORDER,
  kindGraphDepths,
  MATERIALS_SHELL_KINDS,
  kindsForShellPacking,
  azimuthRadForQueryKey,
} from '../arch/attentionPanel'
export {
  enterCompareForSummonedKeys,
  refreshKeyCompareIfActive,
} from './keyPanelCompare'
export {
  atomSearchText,
  hybridRank,
  isRetrievableAtom,
  refineDraftHits,
  scoreGapAllowsAutoLock,
  tokenizeQuery,
} from './hybridRetrieve'
export {
  defaultComposePolicy,
  parseComposeStrategy,
} from './composePolicy'
export type { ComposePolicy, CrossComposeMode } from './composePolicy'
export { FANOUT_ROLE_NOTE } from './fanoutRoles'
export type { FanoutRole } from './fanoutRoles'
export { buildIdentityRows } from './identityFocus'
export type { IdentityKind, IdentityRow } from './identityFocus'
export {
  buildHarnessContext,
  acceptPathInContext,
  rejectPathInContext,
  registerInferPaths,
  extractFormalOps,
} from './harnessContext'
export {
  compileHarnessProjection,
  compilerBlocksToAbBlocks,
  augmentQuestionWithMarkers,
} from './harnessCompiler'
export {
  buildMotionPlans,
  buildMotionPlansFromDoorPackage,
  pickCorridorFromPackage,
  probeScope,
  motionActionToLetterDecision,
  proposeComposeBags,
} from './motionBrain'
export {
  emptyWorkingSet,
  cloneWorkingSet,
  DEFAULT_ACCEPT_OPTIONS,
} from './harnessTypes'
export type {
  HarnessContext,
  MotionPlan,
  MotionAction,
  WorkingSetState,
  AcceptPathOptions,
  PathMemoryEntry,
  ForbidPatternEntry,
} from './harnessTypes'
export {
  markExpanded,
  markCollapsed,
  keysNeedingOpen,
  applyFaultIn,
  applyCollapse,
} from './workingSet'
export { recordReject, isForbidden, forbidItemsFromPatterns } from './forbidPatterns'
export { loadHarnessPersisted, saveHarnessPersisted } from './harnessPersistence'
export { buildMotionPlansForDesk } from './fanoutRunner'
export { applyMotionPlansToLetterRows } from './letterDesk'
export {
  buildSemanticIndex,
  emptySemanticIndex,
  hasConfirmedToc,
  rankSections,
  keysInSections,
  sectionHitNote,
  semanticTocReady,
  confirmTocSections,
  reconcileTocMemberKeys,
  buildSemanticFromTocEntries,
  collapseSectionsSharingPageRange,
} from './semanticIndex'
export type {
  BookSemanticIndex,
  SectionNode,
  SlotProvenance,
} from './semanticIndex'
export {
  saveSemanticIndex,
  loadSemanticIndex,
  clearSemanticIndex,
} from './semanticIndexStore'
export {
  buildPendingGatewayPlans,
  plansNeedingHumanGate,
  probeFaultInKeys,
  runProbeForPlan,
  executeHarnessMotion,
  allGatewayPlansApproved,
} from './harnessGateway'
export type { PendingGatewayPlan, GatewayGateStatus } from './harnessGateway'
export { inferWithMicroLoop, MAX_MICRO_LOOPS } from './microLoop'
export { recallCandidatesByBm25 } from './retrieveBm25'
export {
  executeInstructionCompose,
  composeInstructionBags,
} from './instructionCompose'
export type { InstructionComposeSpec, InstructionBagMode } from './instructionCompose'
export {
  buildCorridorPackage,
  buildDoorPackage,
  pickDefaultLockCorridor,
} from './letterPackages'
export type {
  CorridorPackage,
  DoorPackage,
  LetterLockState,
} from './letterPackages'
export {
  getKeyDecisionStore,
  rollDoorBrief,
  getDoorEntry,
  briefContentHash,
  doorPeekFamilies,
} from './keyDecisionState'
export type {
  KeyDecisionEntry,
  SuggestAction,
  PeekHangMode,
  RollDoorBriefResult,
} from './keyDecisionState'
export {
  gateBagSubset,
  gateReturnSubset,
  gateFaultInApproved,
  gatePeekSingleKey,
  gateBriefRef,
  combineGates,
} from './hardGates'
export {
  executePeekCast,
  executePeekCastParallel,
} from './peekCast'
export type { PeekCastResult, PeekVerdict } from './peekCast'
export { runSupervisionPass } from './supervisionLoop'
export type { SupervisionReport, SupervisionDelta } from './supervisionLoop'
export {
  makeCalibration,
  normalizeCalibration,
  printedToStrand,
  strandToPrinted,
  printedLoOnStrand,
  printedHiOnStrand,
  maxPrintedForStrand,
  printedRangeToStrandRange,
  printedPerStrandOf,
  calibrationNote,
} from './pageCalibration'
export type { PageCalibration } from './pageCalibration'
export {
  parseTocText,
  fillEndPrinted,
  fillEndStrand,
  emptyTocEntry,
  tocEntryHasStrand,
} from './tocParse'
export type { TocEntryDraft } from './tocParse'
export { runTocMapLlm, applyPrintedCalibration } from './tocMapLlm'
export {
  structureChunkBlocks,
  externalBlocksToPageChunks,
} from './structureChunk'
export type { ExternalLayoutBlock, StructureChunkOptions } from './structureChunk'
export {
  refineCandidateBoxes,
  refineCandidateBoxesAsync,
  resolveInkBoxes,
  normalizeInkText,
} from './inkHighlight'
export type { InkRefineResult } from './inkHighlight'
export {
  collectPageSlotRows,
  exportPageSlotDataset,
} from './slotDatasetExport'
export type { SlotLabelRow } from './slotDatasetExport'
export {
  a1DsChatPromptStub,
  a1DsPromptRules,
  normalizeBriefTag,
  buildA1DsPacks,
  buildA1GlobalExport,
  collectA1DsRows,
  downloadTextFile,
  exportA1ForDeepSeek,
  exportA1ForDeepSeekJsonl,
} from './a1DsExport'
export type { A1DsExportOptions, A1DsPack, A1DsRow } from './a1DsExport'
export { askDeepSeekWithA1, askDeepSeekWithLetterDesk } from './a1DsChat'
export type { A1DsAskResult, A1DsItem } from './a1DsChat'
export { focusA1KeyOnPdf } from './focusA1Key'
export { useAttentionIo, getSelectedEdge } from './attentionIoStore'
export type {
  AttentionEdge,
  AttentionRow,
  AttentionStep,
  DeskConfirmDraft,
  DeskJob,
  InferEdge,
  IntentDeskLogEntry,
  KeyKind,
  LetterDeskPackage,
  LetterDeskPickup,
  NeighbourRecord,
  PathRecord,
  NormRecord,
  PendingPathMatch,
  PendingPathBoundPair,
  PendingReuseProposal,
  PendingReuseCandidate,
  ProspectRecord,
  QueryReuseLink,
} from './attentionIoStore'
export {
  parseInferPaths,
  fallbackInferPaths,
  parseReuseJudgments,
  parseQueryNeighbours,
  parsePathMatches,
  parsePathValidityJudgments,
  salvagePathJudgmentObjectsByRegex,
  inferKeyOf,
  queryKeyOfQuestion,
  mintInferKey,
  mintQueryKey,
  fingerprintOfInfer,
  fingerprintOfQuestion,
  asBookKeys,
} from './inferPath'
export {
  bindInferProspectByBookLineage,
  bindSolutionsByBookLineage,
  bookKeysForInferFromDecideLineage,
  composeNormTextFromPath,
  prospectBookKey,
  resolveBriefBookKey,
} from './pathLineageBind'
export type { LineageBoundPair } from './pathLineageBind'
export {
  contentFingerprint,
  mintInstanceKey,
  newSettleActionId,
  newLlmCallId,
  settleOnce,
  expandIncrementSlots,
  statusAllowsMint,
} from './settleMint'
export type { InstanceKind, SettleJob } from './settleMint'
export type {
  InferStepRaw,
  InferPathRaw,
  ReuseJudgment,
  QueryNeighbourRow,
} from './inferPath'
export { runAutoFlow, parseDecideKeepBriefKeys, parseDecideOutcome, normalizeDecideCoverage } from './autoFlow'
export {
  parseSeedRange,
  parseSeedRangeDraft,
  fallbackSeedRange,
  expandSeedRangeToBookKeys,
  expandClosedSeedRangesToBookKeys,
  expandStrandRangesToBookKeys,
  closeSeedRangeDrafts,
  briefsAfterCursor,
  orderedRetrievableBookKeys,
} from './seedRange'
export type { SeedRange, SeedRangeDraft, StrandRange } from './seedRange'
export {
  parseAttentionArrival,
  deskMonitorAttentionArrival,
  ingestKeyIncrementStatuses,
} from './attentionArrival'
export type { AttentionArrival } from './attentionArrival'
export {
  normalizeIncrementStatus,
  parseKeyIncrementStatuses,
  keysReadyToDeliver,
  keysNeedingMore,
  keysUnread,
  keyStatusContractHint,
  unreadForceCommitInstruction,
} from './keyIncrementStatus'
export type {
  IncrementReadStatus,
  KeyIncrementStatusRow,
  KeyStatusScope,
  StatusJob,
} from './keyIncrementStatus'
export {
  detectIntroducedIo,
  heuristicIntent,
  classifyUtterance,
  runComposerTurn,
} from './intentDeskRouter'
export {
  gatherCritiqueLedger,
  runSuperviseCritique,
  priorInferKeysForQuery,
  heuristicCritique,
} from './superviseCritique'
export type {
  CritiqueFault,
  CritiqueDecision,
  CritiqueAutopsy,
  CritiqueLedger,
  PredictSub,
  ReasonSub,
} from './superviseCritique'
export { executeSuperviseCritique } from './superviseCritiqueExec'
export {
  prospectIsomorphicToAny,
  filterKeepsAvoidingBadProspects,
} from './prospectIsomorph'
export { inspectQueryGap } from './gapNavigation'
export type { GapKind, QueryGap } from './gapNavigation'
export {
  PEEK_BRIEF_INSTRUCTION,
  PEEK_HOT_INSTRUCTION_SUFFIX,
  PEEK_USER_ASIDE_HINT,
} from './peekInstruction'
export {
  resolveFirstStepBranch,
  resolveAskLineBranch,
  needsColdPeekPrecondition,
  historicQueryKeysWithNorms,
  deskHasSettledQueryKeys,
  listSettledQueryEntries,
  listHistoricQueryEntriesForNeighbour,
} from './deskEntryGate'
export type { AskLineBranch, AutoEntryBranch } from './deskEntryGate'
export {
  getQueryRoot,
  listQueryAncestors,
  listQueryChildren,
  listQueryFamilyKeys,
  listQuerySelfAndAncestors,
} from '../arch/queryLineage'
export {
  lookupContract,
  DESK_CONTRACTS,
} from './letterDeskContracts'
export type { DeskContract, ContractKeyKind } from './letterDeskContracts'
export {
  briefKeysUsedByPath,
  briefKeysUsedByPaths,
} from './pathBriefExclusion'
export {
  expandSeedsForJob,
  assembleWindow,
  dispatchLetterDesk,
  reverseLookupExcludeQuestions,
  runReuseGate,
  listNeighbourHistoricsOrdered,
  listCandidateInferEdges,
  listCandidatePathsViaNeighbours,
  skipPendingPathMatchToSupervise,
  runPathMatchSuperviseIfNeeded,
} from './letterDeskDispatch'
export {
  buildWindowAliasTable,
  displayWindowAlias,
  expandDoorplatesInLlmText,
  formatDeskMaterialSlot,
  resolveWindowDoorplate,
  isWindowAlias,
  windowAliasContractHint,
  slotAlias,
  parseDeskSlotIndex,
} from '../arch/windowAlias'
export type { WindowAliasTable } from '../arch/windowAlias'
export {
  mapBriefToBook,
  mapBookToHeadBrief,
  listBriefVersionsOnDoor,
  doorHasBrief,
  docHasAnyBrief,
  listAllHeadBriefs,
  listAllSettledBriefs,
} from './masterTableMap'
export {
  collectPlainTexts,
  extractS0FromBookIndex,
  extractS0FromPlainTexts,
  attachBookKeysByLocate,
  buildResidualPlainTexts,
  buildS1BatchesByS0Gaps,
  chunkLongTextSerial,
  joinResidualBatchText,
  buildBookNounIndexRulesOnly,
  maskSurfacesInText,
  dedupeNounDrafts,
  mergeS0S1,
  mergeS0S1Drafts,
  surfacesToDrafts,
} from '../arch/bookNounIndex'
export type {
  BookNounDraft,
  BookNounEntry,
  BookNounIndex,
  PlainText,
  ResidualBatch,
} from '../arch/bookNounIndex'
export {
  S1_DICTATION_SYSTEM,
  buildS1DictationUserPrompt,
  previewS1DictationMessages,
  parseS1NounsFromLlm,
  gateNounsAgainstBatchText,
  runS1DictationOnBatch,
  runBookNounS1Dictation,
} from '../arch/bookNounS1Dictation'
export type {
  S1BatchResult,
  S1BatchRoundAudit,
  S1Reject,
  RunS1DictationResult,
} from '../arch/bookNounS1Dictation'
