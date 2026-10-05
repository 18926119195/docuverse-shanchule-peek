/**
 * 架构现码清单：本目录为协议/铸键/空位事实的集中源；
 * 下列文件仍在 src/reasoning（强依赖 UI/store），后续可继续迁入。
 */
export const ARCH_CORE_FILES = [
  'settleMint.ts',
  'bookKey.ts',
  'doorFace.ts',
  'attentionPanel.ts',
  'pageMark.ts',
  'gapNavigation.ts',
  'keyIncrementStatus.ts',
  'deskEntryGate.ts',
  'coldPeekSkeleton.ts',
  'letterDeskContracts.ts',
  'peekInstruction.ts',
  'pathBriefExclusion.ts',
  'pathIncrementReturn.ts',
  'seedRange.ts',
  'deskDelivery.ts',
  'parallelLlmBatch.ts',
  'bookNounIndex.ts',
  'bookNounS1Dictation.ts',
] as const

export const ARCH_RELATED_IN_REASONING = [
  'attentionIoStore.ts',
  'intentDeskRouter.ts',
  'autoFlow.ts',
  'letterDeskDispatch.ts',
  'a1DsChat.ts',
  'a1DsExport.ts',
  'inferPath.ts',
  'keyDecisionState.ts',
  'masterTableMap.ts',
  'attentionArrival.ts',
  'pageMarkStore.ts',
  'emphasizeMint.ts',
  'panelEmphasizeStore.ts',
  'keyWorldAnchor.ts',
] as const
