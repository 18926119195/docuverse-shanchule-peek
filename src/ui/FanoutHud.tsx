import { useEffect, useMemo, useState } from 'react'
import { useDocuverse } from '../canvas/store'
import { useFanout } from '../reasoning/fanoutStore'
import {
  executeLetterDesk,
  prepareLetterDesk,
  rebuildLetterDeskWithLock,
  buildMotionPlansForDesk,
  relockCorridorOnDesk,
} from '../reasoning/fanoutRunner'
import { executePeekCastParallel } from '../reasoning/peekCast'
import { runSupervisionPass } from '../reasoning/supervisionLoop'
import {
  strategyLabel,
  applyMotionPlansToLetterRows,
  snapshotFromRows,
} from '../reasoning/letterDesk'
import type { LetterRunStrategy, LetterUnitDecision } from '../reasoning/letterDesk'
import { recommendToolClasses } from '../reasoning/toolArchive'
import { resolveLineage } from '../reasoning/lineage'
import { emptyCurrentObject } from '../reasoning/currentObject'
import { LOCKED_LLM } from '../reasoning/modelRuntimeConfig'
import { useIndexGate } from '../reasoning/indexGate'
import { shortHandle } from '../reasoning/ocrSlot'
import { buildIdentityRows } from '../reasoning/identityFocus'
import {
  defaultComposePolicy,
  parseComposeStrategy,
  type ComposePolicy,
} from '../reasoning/composePolicy'
import type { ActionRecord } from '../reasoning/types'
import { WorkingMemoryPanel } from './WorkingMemoryPanel'

export function FanoutHud() {
  const corpus = useDocuverse((s) => s.corpus)
  const pages = useDocuverse((s) => s.pages)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)

  const bookIndex = useIndexGate((s) => s.bookIndex)
  const semanticIndex = useIndexGate((s) => s.semanticIndex)
  const indexReady = useIndexGate((s) => s.ready)
  const indexPhase = useIndexGate((s) => s.phase)
  const indexMessage = useIndexGate((s) => s.message)

  const setCorpus = useFanout((s) => s.setCorpus)
  const phase = useFanout((s) => s.phase)
  const progress = useFanout((s) => s.progress)
  const error = useFanout((s) => s.error)
  const paths = useFanout((s) => s.paths)
  const acceptedPaths = useFanout((s) => s.acceptedPaths)
  const actionLog = useFanout((s) => s.actionLog)
  const acceptedActionLog = useFanout((s) => s.acceptedActionLog)
  const activePathId = useFanout((s) => s.activePathId)
  const lastQuestion = useFanout((s) => s.lastQuestion)
  const draftReport = useFanout((s) => s.draftReport)
  const acceptedQuestion = useFanout((s) => s.acceptedQuestion)
  const selectedSlotKey = useFanout((s) => s.selectedSlotKey)
  const focusedActionId = useFanout((s) => s.focusedActionId)
  const focusedIdentityId = useFanout((s) => s.focusedIdentityId)
  const setPhase = useFanout((s) => s.setPhase)
  const setError = useFanout((s) => s.setError)
  const setRunResult = useFanout((s) => s.setRunResult)
  const setActivePathId = useFanout((s) => s.setActivePathId)
  const acceptPathWithOptions = useFanout((s) => s.acceptPathWithOptions)
  const rejectPath = useFanout((s) => s.rejectPath)
  const setMotionPlans = useFanout((s) => s.setMotionPlans)
  const lastMotionPlans = useFanout((s) => s.lastMotionPlans)
  const workingSet = useFanout((s) => s.workingSet)
  const forbidPatterns = useFanout((s) => s.forbidPatterns)
  const focusIdentity = useFanout((s) => s.focusIdentity)
  const clearRun = useFanout((s) => s.clearRun)
  const letterDesk = useFanout((s) => s.letterDesk)
  const letterSession = useFanout((s) => s.letterSession)
  const deferredArchive = useFanout((s) => s.deferredArchive)
  const letterStrategy = useFanout((s) => s.letterStrategy)
  const expandBudget = useFanout((s) => s.expandBudget)
  const setLetterPrepare = useFanout((s) => s.setLetterPrepare)
  const updateLetterDecision = useFanout((s) => s.updateLetterDecision)
  const reproposeLetter = useFanout((s) => s.reproposeLetter)
  const clearLetterDesk = useFanout((s) => s.clearLetterDesk)
  const setLetterStrategy = useFanout((s) => s.setLetterStrategy)
  const setExpandBudget = useFanout((s) => s.setExpandBudget)
  const removeDeferred = useFanout((s) => s.removeDeferred)
  const inferredPaths = useFanout((s) => s.inferredPaths)
  const currentObject = useFanout((s) => s.currentObject)
  const reasonModelId = useFanout((s) => s.reasonModelId)
  const lockObjectFromDraft = useFanout((s) => s.lockObjectFromDraft)
  const setCurrentObject = useFanout((s) => s.setCurrentObject)
  const replaceLetterSession = useFanout((s) => s.replaceLetterSession)
  const returnToLetterDesk = useFanout((s) => s.returnToLetterDesk)
  const appendActions = useFanout((s) => s.appendActions)

  const [question, setQuestion] = useState('')
  const [pilotOpen, setPilotOpen] = useState(false)
  const [stepOpen, setStepOpen] = useState(true)
  const [identityOpen, setIdentityOpen] = useState(true)
  const [deferredOpen, setDeferredOpen] = useState(false)
  const [lineageOpen, setLineageOpen] = useState(false)
  const [assetsOpen, setAssetsOpen] = useState(false)
  const [policy, setPolicy] = useState<ComposePolicy>(() =>
    defaultComposePolicy(),
  )
  const [strategyDraft, setStrategyDraft] = useState('')
  const [strategyNote, setStrategyNote] = useState('')
  const [acceptDialogOpen, setAcceptDialogOpen] = useState(false)
  const [acceptPinCurrent, setAcceptPinCurrent] = useState(true)
  const [showGeoCompose, setShowGeoCompose] = useState(false)
  const [lockCorridorId, setLockCorridorId] = useState<string>('')
  const [supervisionNote, setSupervisionNote] = useState('')

  useEffect(() => {
    setCorpus(corpus || 'default')
  }, [corpus, setCorpus])

  useEffect(() => {
    const seed = lastQuestion || acceptedQuestion
    if (seed && !question) setQuestion(seed)
  }, [lastQuestion, acceptedQuestion, question])

  /** 本轮扇出结果 only — 已采纳资产不并入路径条（回流只待复用） */
  const roundPaths = paths

  /** 身份/谱系仍可看见资产，但不进「推理路径」页签 */
  const identitySourcePaths = useMemo(() => {
    const byId = new Map(roundPaths.map((p) => [p.pathId, p]))
    for (const p of acceptedPaths) {
      if (!byId.has(p.pathId)) byId.set(p.pathId, p)
    }
    return [...byId.values()]
  }, [roundPaths, acceptedPaths])

  const allActions = useMemo(() => {
    const byId = new Map<string, ActionRecord>()
    for (const a of acceptedActionLog) byId.set(a.actionId, a)
    for (const a of actionLog) byId.set(a.actionId, a)
    return [...byId.values()]
  }, [actionLog, acceptedActionLog])

  const identityRows = useMemo(
    () => buildIdentityRows({ paths: identitySourcePaths, actions: allActions }),
    [identitySourcePaths, allActions],
  )

  const active = useMemo(() => {
    if (!activePathId) return null
    return (
      roundPaths.find((p) => p.pathId === activePathId) ??
      acceptedPaths.find((p) => p.pathId === activePathId) ??
      null
    )
  }, [roundPaths, acceptedPaths, activePathId])

  const viewingAssetOnly = useMemo(() => {
    if (!activePathId) return false
    if (roundPaths.some((p) => p.pathId === activePathId)) return false
    return acceptedPaths.some((p) => p.pathId === activePathId)
  }, [activePathId, roundPaths, acceptedPaths])

  const activeSteps = useMemo(() => {
    if (!active) return []
    return active.actionIds
      .map((id) => allActions.find((a) => a.actionId === id))
      .filter((a): a is ActionRecord => Boolean(a))
  }, [active, allActions])

  const focusedAction = useMemo(
    () => allActions.find((a) => a.actionId === focusedActionId) ?? null,
    [allActions, focusedActionId],
  )

  const busy =
    phase === 'retrieving' || phase === 'composing' || phase === 'inferring'
  const reviewing = phase === 'review' && letterDesk != null

  const toolRecs = useMemo(
    () =>
      recommendToolClasses({
        hasObjectLock: currentObject.lockedBy !== 'none',
        hasDraftHits: (draftReport?.candidates.length ?? 0) > 0,
        hasInferredOrAccepted:
          inferredPaths.length > 0 || acceptedPaths.length > 0,
      }),
    [
      currentObject.lockedBy,
      draftReport?.candidates.length,
      inferredPaths.length,
      acceptedPaths.length,
    ],
  )

  const lineageNodes = useMemo(() => {
    if (!focusedIdentityId && !activePathId) return []
    return resolveLineage({
      focusId: focusedIdentityId || activePathId || '',
      paths: identitySourcePaths,
      actions: allActions,
    })
  }, [focusedIdentityId, activePathId, identitySourcePaths, allActions])

  const onPrepareDesk = async () => {
    if (!bookIndex || !indexReady) {
      setError('索引未就绪：请先上传并完成 OCR / 建库')
      return
    }
    const q = question.trim()
    if (!q) {
      setError('请输入问题')
      return
    }
    setError(null)
    setPhase('retrieving', '草稿·检索候选 key*…')
    try {
      const state = useFanout.getState()
      const prepared = await prepareLetterDesk(bookIndex, q, {
        topK: 5,
        concurrency: 3,
        pageCount: Math.max(pages.length, 1),
        policy,
        semanticIndex:
          semanticIndex?.tocConfirmed === true ? semanticIndex : null,
        instructionCompose: true,
        letterLock: lockCorridorId
          ? { lockCorridor: lockCorridorId, skipPackageA: true }
          : undefined,
        acceptedPaths: state.acceptedPaths,
        inferredPaths: state.inferredPaths,
        reuseAcceptedCombos: false,
        letterStrategy,
        expandBudget,
        lockedSlotKeys:
          state.currentObject.lockedBy !== 'none'
            ? state.currentObject.slotKeys
            : undefined,
        modelId: state.reasonModelId || LOCKED_LLM.chatModel,
        onProgress: (msg) => {
          if (msg.includes('写信') || msg.includes('组合') || msg.includes('指令'))
            setPhase('composing', msg)
          else setPhase('retrieving', msg)
        },
      })
      if (!prepared.ok) {
        appendActions(prepared.actions)
        setError(prepared.error || '写信台准备失败')
        setPhase('error', '')
        return
      }
      if (prepared.session.lockCorridor) {
        setLockCorridorId(prepared.session.lockCorridor)
      }
      const plans = buildMotionPlansForDesk({
        question: q,
        docId: state.corpus,
        units: prepared.session.units,
        acceptedPaths: state.acceptedPaths,
        inferredPaths: state.inferredPaths,
        workingSet: state.workingSet,
        forbidPatterns: state.forbidPatterns,
        expandBudget,
        draftKeys: prepared.session.draftReport.candidates.map((c) => c.key),
        archiveOnlyPathIds: state.archiveOnlyPathIds,
        doorPackage: prepared.session.doorPackage,
      })
      const rows = applyMotionPlansToLetterRows(prepared.session.rows, plans)
      const snapshot = snapshotFromRows({
        question: q,
        comboCount: prepared.session.units.length,
        strategy: letterStrategy,
        expandBudget,
        rows,
        status: 'review',
      })
      const session = {
        ...prepared.session,
        rows,
        snapshot,
      }
      setMotionPlans(plans)
      useFanout.getState().refreshPendingGateway(bookIndex)
      setLetterPrepare({
        session,
        actions: prepared.actions,
      })
      const sup = runSupervisionPass({
        question: q,
        deliveredKeys: prepared.session.draftReport.candidates.map((c) => c.key),
        returnedKeys: prepared.session.units.flatMap((u) =>
          u.candidate.R.memberKeys?.length
            ? u.candidate.R.memberKeys
            : [u.candidate.R.key],
        ),
      })
      setSupervisionNote(
        `${sup.delta.summary} · ${sup.delta.tone}` +
          (prepared.session.funnelStage
            ? ` · 漏斗 ${prepared.session.funnelStage}`
            : ''),
      )
      appendActions([sup.action])
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onRebuildWithLock = async () => {
    const session = useFanout.getState().letterSession
    if (!session) {
      setError('请先打开写信台')
      return
    }
    const keys =
      currentObject.slotKeys.length > 0
        ? currentObject.slotKeys
        : draftReport?.candidates.slice(0, 1).map((c) => c.key) ?? []
    if (keys.length === 0) {
      setError('请先锁定对象槽')
      return
    }
    setPhase('composing', '按锁定对象重组合…')
    try {
      const rebuilt = await rebuildLetterDeskWithLock(session, {
        lockedSlotKeys: keys,
        policy,
        strategy: letterStrategy,
        expandBudget,
      })
      if (!rebuilt.ok) {
        if (rebuilt.action) appendActions([rebuilt.action])
        returnToLetterDesk(rebuilt.error || '重组合失败')
        return
      }
      replaceLetterSession(rebuilt.session, rebuilt.action)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const onConfirmExecute = async () => {
    const session = useFanout.getState().letterSession
    if (!session) {
      setError('写信台为空：请先「打开写信台」')
      return
    }
    setError(null)
    setPhase('inferring', '网关·编译 → infer → 监督…')
    try {
      if (!bookIndex) {
        setError('索引未就绪')
        return
      }
      const fanoutState = useFanout.getState()
      const harness = fanoutState.getHarnessExecBundle(bookIndex)
      const result = await executeLetterDesk(session, {
        onProgress: (msg) => setPhase('inferring', msg),
        harness,
      })
      const baseIds = new Set([
        session.retrieveAction.actionId,
        session.composeAction.actionId,
      ])
      const newActions = result.actions.filter((a) => !baseIds.has(a.actionId))
      if (result.returnToDesk) {
        appendActions(newActions)
        returnToLetterDesk(result.error || '执行失败，已回写信台')
        return
      }
      if (!result.ok && result.paths.length === 0 && !result.deferredArchive?.length) {
        appendActions(newActions)
        returnToLetterDesk(result.error || '网关执行失败')
        return
      }
      setRunResult({
        question: session.question,
        paths: result.paths,
        actions: newActions,
        draftReport: result.draftReport ?? null,
        letterDesk: result.letterDesk ?? null,
        deferredArchive: result.deferredArchive ?? [],
        workingSet: result.workingSet,
      })
      const first = result.paths[0]
      if (first) {
        const delivered = first.direction.premiseKeys ?? first.slots.map((s) => s.key)
        const postSup = runSupervisionPass({
          question: session.question,
          deliveredKeys: delivered,
          returnedKeys: delivered,
          conclusion: first.direction.conclusion,
          path: first,
        })
        appendActions([postSup.action])
        setSupervisionNote(
          `${postSup.delta.summary}${postSup.delta.notes.length ? ' · ' + postSup.delta.notes.join(' · ') : ''}`,
        )
        if (first.premisePages[0] !== undefined) {
          swoopToPage(first.premisePages[0])
        }
      }
    } catch (e) {
      returnToLetterDesk(e instanceof Error ? e.message : String(e))
    }
  }

  const onPickIdentity = (row: (typeof identityRows)[number]) => {
    const slotKey = row.slotKeys[0] ?? null
    focusIdentity({
      identityId: row.id,
      kind: row.kind,
      slotKey,
      actionId: row.actionId ?? null,
      pathId: row.pathId ?? null,
    })
    if (row.page !== undefined) swoopToPage(row.page)
    else if (slotKey && bookIndex) {
      const chunk = bookIndex.chunks.find((c) => c.key === slotKey)
      if (chunk) swoopToPage(chunk.page)
    }
  }

  const jumpPremise = (page: number, key: string) => {
    focusIdentity({
      identityId: `slot:${key}`,
      kind: 'slot',
      slotKey: key,
      pathId: activePathId,
    })
    swoopToPage(page)
  }

  const stepTagClass = (kind: ActionRecord['actionKind']) => {
    if (kind === 'retrieve') return 'step-tag retrieve'
    if (kind === 'compose') return 'step-tag compose'
    if (kind === 'accept') return 'step-tag accept'
    if (kind === 'reuse') return 'step-tag reuse'
    return 'step-tag infer'
  }

  const stepTagLabel = (kind: ActionRecord['actionKind']) => {
    if (kind === 'retrieve') return '草稿'
    if (kind === 'compose') return '写信'
    if (kind === 'accept') return '采纳'
    if (kind === 'reuse') return '复用'
    return '网关'
  }

  const decisionLabel = (d: LetterUnitDecision) => {
    if (d === 'reuse') return '复用'
    if (d === 'expand') return '新推'
    return '尚未展开'
  }

  return (
    <aside className="fanout-hud">
      <header className="fanout-hud-head">
        <div className="fanout-hud-title">扇出推理</div>
        <div className="fanout-hud-sub">
          对象钉死 → 工具推荐 → 写信台三态 → 网关 · 模型 {reasonModelId} · 已推断缓存{' '}
          {inferredPaths.length}
        </div>
      </header>

      <div className="fanout-block">
        <div className="fanout-k">当前对象</div>
        <div className="fanout-v muted">{currentObject.label}</div>
        <div className="fanout-actions">
          <button
            type="button"
            className="fanout-btn"
            disabled={busy || !draftReport?.candidates[0]}
            onClick={() => {
              const top = draftReport?.candidates[0]
              if (!top) return
              lockObjectFromDraft([top.key], [top.page], 'user')
            }}
          >
            锁 Top1
          </button>
          <button
            type="button"
            className="fanout-btn"
            disabled={busy || !draftReport?.candidates.length}
            onClick={() => {
              const keys = (draftReport?.candidates ?? []).map((c) => c.key)
              const pages = (draftReport?.candidates ?? []).map((c) => c.page)
              lockObjectFromDraft(keys, pages, 'user')
            }}
          >
            锁全部候选
          </button>
          <button
            type="button"
            className="fanout-btn"
            disabled={busy}
            onClick={() => setCurrentObject(emptyCurrentObject(corpus || 'default'))}
          >
            解除锁定
          </button>
          <button
            type="button"
            className="fanout-btn"
            disabled={busy || !letterSession}
            onClick={() => void onRebuildWithLock()}
          >
            按对象重组合
          </button>
        </div>
      </div>

      <div className="fanout-block">
        <div className="fanout-k">工具类推荐</div>
        <div className="fanout-chips">
          {toolRecs.map((t) => (
            <span key={t.toolClass} className="fanout-chip" title={t.reason}>
              {t.label}
            </span>
          ))}
        </div>
        <p className="fanout-hint">
          对话事件锚（DSH）尚未桥接 · 本轮测书侧 PDF。指纹含模型 id，换模型不命中旧缓存。
        </p>
      </div>

      <label className="fanout-field">
        <span>问题</span>
        <textarea
          rows={3}
          value={question}
          disabled={busy}
          placeholder="例如：找出与无意识相关的段落，并分别推理可能含义…"
          onChange={(e) => setQuestion(e.target.value)}
        />
      </label>

      <div className="fanout-actions">
        <button
          type="button"
          className="fanout-btn primary"
          disabled={busy}
          onClick={() => void onPrepareDesk()}
        >
          {busy && phase !== 'inferring' ? '准备中…' : '① 打开写信台（先审）'}
        </button>
        <button
          type="button"
          className="fanout-btn primary"
          disabled={busy || !letterSession}
          onClick={() => void onConfirmExecute()}
        >
          {phase === 'inferring' ? '执行中…' : '② 确认执行（网关）'}
        </button>
        <button
          type="button"
          className="fanout-btn"
          disabled={busy || (paths.length === 0 && !letterSession)}
          onClick={() => {
            clearLetterDesk()
            clearRun()
          }}
        >
          清空本次
        </button>
      </div>

      <div className="fanout-policy">
        <div className="fanout-paths-label">
          主路径：指令组袋 · 几何配方默认隐藏（兜底）
        </div>
        <label className="fanout-check">
          <input
            type="checkbox"
            checked={showGeoCompose}
            disabled={busy}
            onChange={(e) => setShowGeoCompose(e.target.checked)}
          />
          显示几何配方（兜底）
        </label>
        {showGeoCompose && (
          <>
        <label className="fanout-check">
          <input
            type="checkbox"
            checked={policy.includeFine}
            disabled={busy}
            onChange={(e) =>
              setPolicy((p) => ({ ...p, includeFine: e.target.checked }))
            }
          />
          单槽
        </label>
        <label className="fanout-check">
          <input
            type="checkbox"
            checked={policy.includeSamePageCluster}
            disabled={busy}
            onChange={(e) =>
              setPolicy((p) => ({
                ...p,
                includeSamePageCluster: e.target.checked,
              }))
            }
          />
          同页多槽
        </label>
        <label className="fanout-check">
          <input
            type="checkbox"
            checked={policy.includeWindow}
            disabled={busy}
            onChange={(e) =>
              setPolicy((p) => ({ ...p, includeWindow: e.target.checked }))
            }
          />
          邻接窗
        </label>
        <label className="fanout-check">
          <input
            type="checkbox"
            checked={policy.includeCrossPage}
            disabled={busy}
            onChange={(e) =>
              setPolicy((p) => ({ ...p, includeCrossPage: e.target.checked }))
            }
          />
          跨页
        </label>
        {policy.includeCrossPage && (
          <div className="fanout-cross-opts">
            <label className="fanout-check">
              <input
                type="radio"
                name="crossMode"
                checked={policy.crossMode === 'pages'}
                disabled={busy}
                onChange={() =>
                  setPolicy((p) => ({ ...p, crossMode: 'pages' }))
                }
              />
              指定页
            </label>
            <label className="fanout-check">
              <input
                type="radio"
                name="crossMode"
                checked={policy.crossMode === 'span'}
                disabled={busy}
                onChange={() =>
                  setPolicy((p) => ({ ...p, crossMode: 'span' }))
                }
              />
              页距
            </label>
            <label className="fanout-check">
              <input
                type="radio"
                name="crossMode"
                checked={policy.crossMode === 'exhaustive'}
                disabled={busy}
                onChange={() =>
                  setPolicy((p) => ({ ...p, crossMode: 'exhaustive' }))
                }
              />
              穷尽
            </label>
            {policy.crossMode === 'pages' && (
              <label className="fanout-field">
                <span>页码（1-based，逗号分隔）</span>
                <input
                  className="fanout-input"
                  disabled={busy}
                  value={policy.crossPages.map((p) => p + 1).join(',')}
                  placeholder="例如 3,7"
                  onChange={(e) => {
                    const pages = e.target.value
                      .split(/[,，\s]+/)
                      .map((s) => Number(s.trim()))
                      .filter((n) => Number.isFinite(n) && n >= 1)
                      .map((n) => n - 1)
                    setPolicy((p) => ({
                      ...p,
                      crossPages: [...new Set(pages)].sort((a, b) => a - b),
                    }))
                  }}
                />
              </label>
            )}
            {policy.crossMode === 'span' && (
              <label className="fanout-field">
                <span>最大页距</span>
                <input
                  className="fanout-input"
                  type="number"
                  min={0}
                  disabled={busy}
                  value={policy.crossSpan}
                  onChange={(e) =>
                    setPolicy((p) => ({
                      ...p,
                      crossSpan: Math.max(0, Number(e.target.value) || 0),
                    }))
                  }
                />
              </label>
            )}
            <label className="fanout-field">
              <span>跨页单元上限</span>
              <input
                className="fanout-input"
                type="number"
                min={1}
                disabled={busy}
                value={policy.crossMaxUnits}
                onChange={(e) =>
                  setPolicy((p) => ({
                    ...p,
                    crossMaxUnits: Math.max(1, Number(e.target.value) || 1),
                  }))
                }
              />
            </label>
          </div>
        )}
          </>
        )}
        <label className="fanout-field">
          <span>策略对话（写入后点应用 → 同一套配方）</span>
          <textarea
            rows={2}
            disabled={busy}
            value={strategyDraft}
            placeholder="例如：只要单槽；或：跨页：3和7；或：穷尽跨页最多12"
            onChange={(e) => setStrategyDraft(e.target.value)}
          />
        </label>
        <div className="fanout-actions">
          <button
            type="button"
            className="fanout-btn"
            disabled={busy || !strategyDraft.trim()}
            onClick={() => {
              const { policy: next, note } = parseComposeStrategy(
                strategyDraft,
                policy,
              )
              setPolicy(next)
              setStrategyNote(note)
            }}
          >
            应用策略
          </button>
          <button
            type="button"
            className="fanout-btn"
            disabled={busy}
            onClick={() => {
              setPolicy(defaultComposePolicy())
              setStrategyDraft('')
              setStrategyNote('已恢复默认（单槽+同页，无窗无跨页）')
            }}
          >
            恢复默认
          </button>
        </div>
        {strategyNote && <p className="fanout-hint">{strategyNote}</p>}
      </div>

      {acceptedPaths.length > 0 && (
        <div className="fanout-deferred">
          <button
            type="button"
            className="fanout-linkish"
            onClick={() => setAssetsOpen((v) => !v)}
          >
            {assetsOpen ? '收起' : '展开'}待复用资产库 · {acceptedPaths.length}
            （不进本轮路径条）
          </button>
          <p className="fanout-hint">
            回流只供写信台命中后 reuse，不与本轮推理路径并列。
          </p>
          {assetsOpen && (
            <ul className="fanout-letter-rows">
              {acceptedPaths.map((p) => (
                <li key={p.pathId} className="fanout-letter-row">
                  <button
                    type="button"
                    className={
                      activePathId === p.pathId
                        ? 'fanout-identity-item active'
                        : 'fanout-identity-item'
                    }
                    onClick={() => {
                      setActivePathId(p.pathId)
                      if (p.premisePages[0] !== undefined)
                        swoopToPage(p.premisePages[0])
                    }}
                  >
                    <span className="id-kind asset">asset</span>
                    <span className="id-label">
                      {shortHandle(p.direction.directionId)}
                    </span>
                    <span className="id-detail">
                      {(p.direction.conclusion || '').slice(0, 48) || p.unitLabel}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {!indexReady && (
        <p className="fanout-hint">
          索引：{indexPhase} {indexMessage || '等待就绪后才能提问'}
        </p>
      )}
      {progress && <p className="fanout-hint">{progress}</p>}
      {draftReport && (
        <div className="fanout-block">
          <div className="fanout-k">草稿→写信精度</div>
          <div className="fanout-v muted">
            {draftReport.autoLockOk ? '建议锁 Top1' : 'Top1 分差不足'}
            {' · '}料 {draftReport.candidates.length}/{draftReport.poolSize}
            {draftReport.expandNote ? ` · ${draftReport.expandNote}` : ''}
          </div>
          {draftReport.candidates.length > 0 && (
            <div className="fanout-chips">
              {draftReport.candidates.slice(0, 8).map((c) => (
                <span key={c.key} className="fanout-chip" title={c.key}>
                  {shortHandle(c.key)} · {c.score.toFixed(2)} · p{c.page + 1}
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="fanout-letter-strategy">
        <div className="fanout-paths-label">本轮推理策略（穷尽后怎么挑）</div>
        <label className="fanout-field">
          <span>策略</span>
          <select
            className="fanout-input"
            disabled={busy}
            value={letterStrategy}
            onChange={(e) =>
              setLetterStrategy(e.target.value as LetterRunStrategy)
            }
          >
            <option value="force_expand">全部新推（问线复用走 neighbour→path）</option>
            <option value="budget">新推有预算，其余尚未展开</option>
          </select>
        </label>
        {letterStrategy === 'budget' && (
          <label className="fanout-field">
            <span>本轮新推预算</span>
            <input
              className="fanout-input"
              type="number"
              min={0}
              disabled={busy}
              value={expandBudget}
              onChange={(e) =>
                setExpandBudget(Math.max(0, Number(e.target.value) || 0))
              }
            />
          </label>
        )}
        <p className="fanout-hint">{strategyLabel(letterStrategy)}</p>
      </div>

      {reviewing && letterDesk && bookIndex && (
        <div className="fanout-letter-desk">
          <div className="fanout-paths-label">
            写信台 · 指令袋 {letterDesk.comboCount} · 复用{' '}
            {letterDesk.counts.reuse} · 新推 {letterDesk.counts.expand} · 尚未展开{' '}
            {letterDesk.counts.deferred}
            {letterSession?.lockCorridor
              ? ` · 廊 ${letterSession.lockCorridor}`
              : ''}
          </div>
          {supervisionNote && (
            <p className="fanout-hint">监督 · {supervisionNote}</p>
          )}
          {letterSession?.corridorPackage && (
            <div className="fanout-block">
              <div className="fanout-k">
                包 A · 廊道
                {letterSession.corridorPackage.skipPackageA ? '（已锁 skip）' : ''}
              </div>
              <ul className="fanout-letter-rows">
                {letterSession.corridorPackage.rows.slice(0, 6).map((row) => (
                  <li key={row.nodeId} className="fanout-letter-row">
                    <button
                      type="button"
                      className={
                        lockCorridorId === row.nodeId
                          ? 'fanout-identity-item active'
                          : 'fanout-identity-item'
                      }
                      disabled={busy || !semanticIndex}
                      onClick={() => {
                        void (async () => {
                          if (!letterSession || !semanticIndex) return
                          setLockCorridorId(row.nodeId)
                          const next = await relockCorridorOnDesk(
                            letterSession,
                            row.nodeId,
                            {
                              semanticIndex,
                              letterLock: {
                                lockCorridor: row.nodeId,
                                skipPackageA: true,
                              },
                              expandBudget,
                              strategy: letterStrategy,
                            },
                          )
                          const plans = buildMotionPlansForDesk({
                            question: next.question,
                            docId: useFanout.getState().corpus,
                            units: next.units,
                            acceptedPaths: useFanout.getState().acceptedPaths,
                            inferredPaths: useFanout.getState().inferredPaths,
                            workingSet: useFanout.getState().workingSet,
                            forbidPatterns: useFanout.getState().forbidPatterns,
                            expandBudget,
                            draftKeys: next.draftReport.candidates.map(
                              (c) => c.key,
                            ),
                            doorPackage: next.doorPackage,
                          })
                          const rows = applyMotionPlansToLetterRows(
                            next.rows,
                            plans,
                          )
                          setMotionPlans(plans)
                          replaceLetterSession({
                            ...next,
                            rows,
                            snapshot: snapshotFromRows({
                              question: next.question,
                              comboCount: next.units.length,
                              strategy: letterStrategy,
                              expandBudget,
                              rows,
                              status: 'review',
                            }),
                          })
                        })()
                      }}
                    >
                      {row.title} · p{row.page + 1} · keys=
                      {row.memberKeyCount}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {letterSession?.doorPackage && (
            <div className="fanout-block">
              <div className="fanout-k">
                包 B · 门{' '}
                {letterSession.doorPackage.doors.length} · 袋{' '}
                {letterSession.doorPackage.bags.length}
                {letterSession.doorPackage.weakenPackageB ? ' · weaken' : ''}
              </div>
              <div className="fanout-chips">
                {letterSession.doorPackage.doors.slice(0, 10).map((d) => (
                  <span
                    key={d.key}
                    className="fanout-chip"
                    title={d.doorBrief || d.key}
                  >
                    {shortHandle(d.key)}
                    {d.doorBrief ? '·贴' : ''}
                  </span>
                ))}
              </div>
              <button
                type="button"
                className="fanout-btn"
                disabled={busy || !bookIndex}
                onClick={() => {
                  if (!letterSession || !bookIndex) return
                  const peekKeys = lastMotionPlans
                    .filter((p) => p.action === 'peek')
                    .flatMap((p) => p.faultInKeys)
                  const keys =
                    peekKeys.length > 0
                      ? peekKeys
                      : letterSession.doorPackage!.doors
                          .filter((d) => !d.doorBrief)
                          .slice(0, 3)
                          .map((d) => d.key)
                  const approved = letterSession.doorPackage!.doors.map(
                    (d) => d.key,
                  )
                  const results = executePeekCastParallel({
                    docId: bookIndex.docId,
                    bookIndex,
                    keys,
                    approvedKeys: approved,
                    question: letterSession.question,
                  })
                  appendActions(results.map((r) => r.action))
                  const okN = results.filter((r) => r.ok).length
                  setSupervisionNote(
                    `peek ${okN}/${results.length} · ${results
                      .map((r) => r.verdict)
                      .join(',')}`,
                  )
                }}
              >
                铸贴 peek（并行单键）
              </button>
            </div>
          )}
          {lastMotionPlans.length > 0 && (
            <div className="fanout-block motion-plans-preview">
              <div className="fanout-k">
                运动脑提议 · {lastMotionPlans.length} 条（不含全文 T）
              </div>
              <ul className="fanout-letter-rows">
                {lastMotionPlans.slice(0, 12).map((plan) => (
                  <li key={plan.planId} className="fanout-letter-row">
                    <div className="fanout-v">
                      #{plan.rank} {plan.action}
                      {plan.unitKey ? ` · ${shortHandle(plan.unitKey)}` : ''}
                      <span className="fanout-v muted">
                        {' '}
                        score={plan.score.toFixed(2)}
                      </span>
                    </div>
                    <div className="fanout-hint">{plan.rationale}</div>
                    {plan.faultInKeys.length > 0 && (
                      <div className="fanout-chips">
                        {plan.faultInKeys.map((k) => (
                          <span key={k} className="fanout-chip" title={k}>
                            {shortHandle(k)}
                          </span>
                        ))}
                      </div>
                    )}
                  </li>
                ))}
              </ul>
              {forbidPatterns.filter((p) => p.rejectCount >= 3).length > 0 && (
                <p className="fanout-hint">
                  forbid 模式：{' '}
                  {forbidPatterns.filter((p) => p.rejectCount >= 3).length} 条
                </p>
              )}
              <p className="fanout-hint">
                workingSet expanded={workingSet.expanded.size} collapsed=
                {workingSet.collapsed.size}
              </p>
            </div>
          )}
          <div className="fanout-actions">
            <button
              type="button"
              className="fanout-btn"
              disabled={busy}
              onClick={() => reproposeLetter()}
            >
              按上方策略重提议
            </button>
            <button
              type="button"
              className="fanout-btn"
              disabled={busy}
              onClick={() => clearLetterDesk()}
            >
              关闭写信台
            </button>
          </div>
          <ul className="fanout-letter-rows">
            {letterDesk.rows.map((row) => (
              <li key={row.index} className="fanout-letter-row">
                <div className="fanout-v">
                  #{row.index + 1} {row.label}{' '}
                  <span className="fanout-v muted">
                    [{row.memberKeys.map(shortHandle).join('+')}]
                  </span>
                </div>
                <div className="fanout-letter-decisions">
                  {(['reuse', 'expand', 'deferred'] as LetterUnitDecision[]).map(
                    (d) => (
                      <label key={d} className="fanout-check">
                        <input
                          type="radio"
                          name={`unit-${row.index}`}
                          checked={row.decision === d}
                          disabled={busy}
                          onChange={() => updateLetterDecision(row.index, d)}
                        />
                        {decisionLabel(d)}
                      </label>
                    ),
                  )}
                </div>
                <div className="fanout-hint">{row.rationale}</div>
              </li>
            ))}
          </ul>
        </div>
      )}

      {deferredArchive.length > 0 && (
        <div className="fanout-deferred">
          <button
            type="button"
            className="fanout-linkish"
            onClick={() => setDeferredOpen((v) => !v)}
          >
            {deferredOpen ? '收起' : '展开'}尚未展开存档 · {deferredArchive.length}
          </button>
          {deferredOpen && (
            <ul className="fanout-letter-rows">
              {deferredArchive.map((d) => (
                <li key={d.id} className="fanout-letter-row">
                  <div className="fanout-v">
                    {d.label} [{d.memberKeys.map(shortHandle).join('+')}]
                  </div>
                  <div className="fanout-hint">
                    Q: {d.question.slice(0, 60)}
                    {d.question.length > 60 ? '…' : ''}
                  </div>
                  <button
                    type="button"
                    className="fanout-btn"
                    onClick={() => removeDeferred(d.id)}
                  >
                    移除
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {error && <p className="fanout-error">{error}</p>}

      <button
        type="button"
        className="fanout-linkish"
        onClick={() => setIdentityOpen((v) => !v)}
      >
        {identityOpen ? '收起身份操控台' : '展开身份操控台'}
      </button>
      {identityOpen && (
        <div className="fanout-identity">
          <div className="fanout-paths-label">
            身份（点选 → 场景绿框 + 账本）· {identityRows.length}
          </div>
          <ul className="fanout-identity-list">
            {identityRows.length === 0 && (
              <li className="fanout-hint">扇出或采纳后出现可点身份</li>
            )}
            {identityRows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className={
                    focusedIdentityId === row.id
                      ? 'fanout-identity-item active'
                      : 'fanout-identity-item'
                  }
                  onClick={() => onPickIdentity(row)}
                  title={row.id}
                >
                  <span className={`id-kind ${row.kind}`}>{row.kind}</span>
                  <span className="id-label">{row.label}</span>
                  <span className="id-detail">{row.detail}</span>
                </button>
              </li>
            ))}
          </ul>
          {focusedAction && (
            <div className="fanout-identity-ledger">
              <div className="fanout-k">账本投影（后端）</div>
              <div className="fanout-v muted">
                {focusedAction.actionKind} · {focusedAction.actionId}
              </div>
              <div className="fanout-v">
                premiseKeys:{' '}
                {focusedAction.premiseKeys.map(shortHandle).join('+') || '（空）'}
              </div>
              <div className="fanout-v muted">
                {focusedAction.outputsRef.roleNote ||
                  focusedAction.outputsRef.conclusion ||
                  focusedAction.outputsRef.error ||
                  '—'}
              </div>
            </div>
          )}
          <button
            type="button"
            className="fanout-linkish"
            onClick={() => setLineageOpen((v) => !v)}
          >
            {lineageOpen ? '收起谱系' : '展开谱系（本地）'}
          </button>
          {lineageOpen && (
            <ul className="fanout-letter-rows">
              {lineageNodes.length === 0 && (
                <li className="fanout-hint">点选身份或路径后显示谱系</li>
              )}
              {lineageNodes.map((n) => (
                <li key={n.id} className="fanout-letter-row">
                  <div className="fanout-v">
                    {n.kind} · {n.label}
                  </div>
                  <div className="fanout-hint">{n.detail}</div>
                </li>
              ))}
            </ul>
          )}
          {selectedSlotKey && (
            <div className="fanout-hint">
              场景投影（前端）：当前路径全部引用绿框已高亮 · 焦点槽{' '}
              {shortHandle(selectedSlotKey)}
            </div>
          )}
        </div>
      )}

      {roundPaths.length > 0 && (
        <div className="fanout-paths">
          <div className="fanout-paths-label">
            本轮推理路径 · {roundPaths.length}
            {roundPaths.some((p) => p.direction.accepted === true)
              ? ` · 本轮已点采纳 ${roundPaths.filter((p) => p.direction.accepted === true).length}`
              : ''}
          </div>
          <div className="fanout-path-tabs">
            {roundPaths.map((p, i) => (
              <button
                key={p.pathId}
                type="button"
                className={
                  p.pathId === activePathId ? 'fanout-tab active' : 'fanout-tab'
                }
                onClick={() => {
                  setActivePathId(p.pathId)
                  if (p.premisePages[0] !== undefined)
                    swoopToPage(p.premisePages[0])
                }}
              >
                #{i + 1}
                {p.direction.accepted === true
                  ? ' ✓'
                  : p.direction.accepted === false
                    ? ' ✗'
                    : ''}
                {p.reusedFromPathId ? ' ↩' : ''}
              </button>
            ))}
          </div>
        </div>
      )}

      {active && (
        <div className="fanout-active">
          {viewingAssetOnly && (
            <p className="fanout-hint">
              正在查看待复用资产（非本轮路径条）。回流待命中；下次写信命中才会
              reuse。
            </p>
          )}
          <div className="fanout-block">
            <div className="fanout-k">结论</div>
            <div className="fanout-v">{active.direction.conclusion || '—'}</div>
          </div>
          {active.direction.pathMarker && (
            <div className="fanout-block">
              <div className="fanout-k">路径标记（机读回流 · 少占上下文）</div>
              <pre className="fanout-path-marker">{active.direction.pathMarker}</pre>
            </div>
          )}
          <div className="fanout-block">
            <div className="fanout-k">过程</div>
            <div className="fanout-v muted">{active.direction.path || '—'}</div>
          </div>
          <div className="fanout-block">
            <div className="fanout-k">组合范围</div>
            <div className="fanout-v muted">
              {active.composeScope === 'cross_page'
                ? '跨页组合'
                : active.composeScope === 'same_page'
                  ? '同页组合'
                  : active.composeScope
                    ? '单槽'
                    : '（旧路径无字段，请重新扇出）'}
              {' · '}
              {active.unitLabel || '—'}
              {active.reusedFromPathId
                ? ` · 已复用（未再推理）← ${active.reusedFromPathId}`
                : ''}
            </div>
          </div>
          <div className="fanout-block">
            <div className="fanout-k">前提身份</div>
            <div className="fanout-chips">
              {(active.direction.premiseKeys ?? []).map((key, i) => {
                const page = active.premisePages[i] ?? active.premisePages[0]
                return (
                  <button
                    key={key}
                    type="button"
                    className={
                      selectedSlotKey === key
                        ? 'fanout-chip active'
                        : 'fanout-chip'
                    }
                    onClick={() => jumpPremise(page ?? 0, key)}
                    title={key}
                  >
                    {shortHandle(key)} · p{(page ?? 0) + 1}
                  </button>
                )
              })}
            </div>
          </div>

          <WorkingMemoryPanel
            path={active}
            selectedKey={selectedSlotKey}
            onKeyClick={(key, page) => jumpPremise(page, key)}
          />

          <div className="fanout-accept">
            <button
              type="button"
              className="fanout-btn primary"
              onClick={() => {
                setAcceptPinCurrent(true)
                setAcceptDialogOpen(true)
              }}
            >
              采纳…
            </button>
            <button
              type="button"
              className="fanout-btn danger"
              onClick={() => active && rejectPath(active.pathId)}
            >
              拒绝（discarded）
            </button>
          </div>
          {acceptDialogOpen && active && (
            <div className="fanout-accept-dialog">
              <div className="fanout-k">采纳分区</div>
              <label className="fanout-check">
                <input
                  type="radio"
                  name="accept-tier"
                  checked={acceptPinCurrent}
                  onChange={() => setAcceptPinCurrent(true)}
                />
                定在当前任务（currentMemory · pathMarker 进下轮 prompt）
              </label>
              <label className="fanout-check">
                <input
                  type="radio"
                  name="accept-tier"
                  checked={!acceptPinCurrent}
                  onChange={() => setAcceptPinCurrent(false)}
                />
                只进永久库（archiveOnly · 须 scopeRequest 才能搜）
              </label>
              <div className="fanout-actions">
                <button
                  type="button"
                  className="fanout-btn primary"
                  onClick={() => {
                    acceptPathWithOptions(active.pathId, {
                      pinToCurrent: acceptPinCurrent,
                      lineageClosure: true,
                    })
                    setAcceptDialogOpen(false)
                  }}
                >
                  确认采纳
                </button>
                <button
                  type="button"
                  className="fanout-btn"
                  onClick={() => setAcceptDialogOpen(false)}
                >
                  取消
                </button>
              </div>
            </div>
          )}
          {active.direction.accepted === true ? (
            <p className="fanout-hint">
              已铸资产 {shortHandle(active.direction.directionId)} · 路径标记已回流
            </p>
          ) : (
            <p className="fanout-hint">
              pending：采纳后进 historical；拒绝默认 discarded，重复≥3 次 → forbid
            </p>
          )}

          <button
            type="button"
            className="fanout-linkish"
            onClick={() => setStepOpen((v) => !v)}
          >
            {stepOpen ? '收起步骤存档' : '展开步骤存档'}
          </button>
          {stepOpen && (
            <ul className="fanout-steps">
              {activeSteps.map((a) => (
                <li
                  key={a.actionId}
                  className={
                    focusedActionId === a.actionId ? 'step-focused' : undefined
                  }
                >
                  <button
                    type="button"
                    className={stepTagClass(a.actionKind)}
                    onClick={() =>
                      focusIdentity({
                        identityId: `action:${a.actionId}`,
                        kind: 'action',
                        actionId: a.actionId,
                        slotKey: a.premiseKeys[0] ?? null,
                        pathId: active.pathId,
                      })
                    }
                  >
                    {stepTagLabel(a.actionKind)}
                  </button>
                  <div className="step-body">
                    {a.actionKind === 'retrieve' && (
                      <>
                        <div className="fanout-hint">
                          {a.outputsRef.roleNote || '草稿：候选 key*，非注入'}
                        </div>
                        <div>问：{a.inputsRef.question}</div>
                        <div>
                          草稿门牌：
                          {(
                            a.outputsRef.draftKeys ??
                            a.outputsRef.candidateKeys ??
                            []
                          )
                            .map((k) => shortHandle(k))
                            .join(', ') || '—'}
                        </div>
                      </>
                    )}
                    {a.actionKind === 'compose' && (
                      <>
                        <div className="fanout-hint">
                          {a.outputsRef.roleNote || '写信：选定 member_keys'}
                        </div>
                        <div>
                          原料：
                          {(a.inputsRef.sourceKeys ?? [])
                            .map((k) => shortHandle(k))
                            .join(', ') || '—'}
                        </div>
                        <div>
                          单元：
                          {(a.outputsRef.units ?? [])
                            .map(
                              (u) =>
                                `${u.label}[${u.memberKeys.map((k) => shortHandle(k)).join('+')}]`,
                            )
                            .join(' · ') ||
                            a.outputsRef.error ||
                            '—'}
                        </div>
                      </>
                    )}
                    {a.actionKind === 'infer' && (
                      <>
                        <div className="fanout-hint">
                          {a.outputsRef.roleNote || '网关：实喂注入并记账'}
                        </div>
                        <div>锁：{shortHandle(a.inputsRef.lockKey || '')}</div>
                        <div>
                          注入成员：
                          {a.premiseKeys.map((k) => shortHandle(k)).join('+') ||
                            '—'}
                        </div>
                        <div>
                          结：
                          {a.outputsRef.conclusion || a.outputsRef.error || '—'}
                        </div>
                      </>
                    )}
                    {a.actionKind === 'accept' && (
                      <>
                        <div className="fanout-hint">
                          {a.outputsRef.roleNote || '采纳：铸资产身份'}
                        </div>
                        <div>
                          资产：{shortHandle(a.outputsRef.assetId || '')}
                        </div>
                        <div>
                          前提：
                          {a.premiseKeys.map((k) => shortHandle(k)).join('+') ||
                            '—'}
                        </div>
                        <div>结：{a.outputsRef.conclusion || '—'}</div>
                      </>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <button
        type="button"
        className="fanout-linkish"
        onClick={() => setPilotOpen((v) => !v)}
      >
        {pilotOpen ? '隐藏单锁 Pilot' : '显示单锁 Pilot（调试）'}
      </button>
      <PilotVisibility open={pilotOpen} />
    </aside>
  )
}

function PilotVisibility({ open }: { open: boolean }) {
  useEffect(() => {
    document.body.classList.toggle('fanout-pilot-open', open)
    return () => document.body.classList.remove('fanout-pilot-open')
  }, [open])
  return null
}
