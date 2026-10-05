/**
 * 执行监督归因结果 → 写信台调度（预测轨 / 狭义推理轨）。
 *
 * 预测 · 同问（reframe/need_peek/drop）：禁本轮坏 path，其它 neighbour path 可 reuse。
 * 预测 · revise_q：新问独立 qk → 标准流（含 reuse）；旧 ι/prospect 不当继承。
 * 狭义推理：跳过 decide；必排坏 ι（same_q | deepen）。
 */

import type { BookIndex } from './pipelineA'
import { useAttentionIo, type LetterDeskPackage } from './attentionIoStore'
import { askDeepSeekWithLetterDesk } from './a1DsChat'
import { mapBriefToBook, listAllSettledBriefs } from './masterTableMap'
import type { CritiqueDecision } from './superviseCritique'
import { priorInferKeysForQuery } from './superviseCritique'
import { runAutoFlow } from './autoFlow'

function sid(): string {
  return `crit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 本轮 decide 之后才算「新预测」；排除尸检标明的坏 prospect */
function freshProspectsForPredict(
  queryKey: string,
  afterMs: number,
  badProspectKeys: string[],
) {
  const st = useAttentionIo.getState()
  const family = new Set(st.listQuerySelfAndAncestors(queryKey))
  const bad = new Set(badProspectKeys)
  return st.prospects
    .filter(
      (p) =>
        family.has(p.queryKey) &&
        p.createdAt >= afterMs &&
        !bad.has(p.prospectKey),
    )
    .sort((a, b) => b.createdAt - a.createdAt)
}

function badPathsOf(decision: CritiqueDecision): string[] {
  return [...new Set(decision.autopsy.badPathKeys.filter(Boolean))]
}

export async function executeSuperviseCritique(input: {
  decision: CritiqueDecision
  queryKey: string
  bookIndex: BookIndex
  userText: string
  onProgress?: (msg: string) => void
  sealItems: Parameters<typeof runAutoFlow>[0]['sealItems']
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const { decision, queryKey, bookIndex } = input
  const st = useAttentionIo.getState()
  const q = st.settledQueries[queryKey] || input.userText
  const docId = bookIndex.docId

  if (decision.fault === 'ask_user') {
    st.setDeskPrompt(`写信台 · 监督：${decision.why}`)
    return { ok: false, answer: '', note: `critique_ask_user · ${decision.why}` }
  }

  // ——— 狭义推理轨：必带排除坏 ι，不过 decide ———
  if (decision.fault === 'reason_narrow') {
    let runQ = q
    let runQk = queryKey
    if (decision.reasonSub === 'deepen') {
      const deep =
        decision.deepenQuestion?.trim() ||
        input.userText
          .replace(/^(请)?(深化|收窄|更具体|监督)[：:\s]*/i, '')
          .trim() ||
        q
      runQk = st.ensureDeepenedQueryKey({
        parentQueryKey: queryKey,
        question: deep,
      })
      runQ = st.settledQueries[runQk] || deep
    }

    const excludeKeys = [
      ...new Set([
        ...decision.autopsy.excludeInferKeys,
        ...priorInferKeysForQuery(queryKey),
        ...priorInferKeysForQuery(runQk),
      ]),
    ]
    if (excludeKeys.length === 0) {
      return {
        ok: false,
        answer: '',
        note: 'reason_narrow 但无可排除的先验 ι · 拒绝无差分重跑',
      }
    }

    const briefs =
      decision.autopsy.keepBriefKeys.length > 0
        ? decision.autopsy.keepBriefKeys
        : st.queryKeyToBriefKeys[runQk] ??
          st.queryKeyToBriefKeys[queryKey] ??
          listAllSettledBriefs(docId).map((b) => b.briefKey)
    const briefKey = briefs[0] || ''
    const bookKey =
      (briefKey && mapBriefToBook(docId, briefKey)?.bookKey) ||
      decision.autopsy.touchedBookKeys[0] ||
      ''

    const pkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `critique_infer_${runQk}`,
      bookKey,
      briefKey,
      question: runQ,
      job: 'infer',
      versionIndex: 0,
      createdAt: Date.now(),
      excludeMode: 'B',
      excludeInferKeys: excludeKeys,
      onlyBriefKeys: briefs.length ? briefs : undefined,
    }
    input.onProgress?.(
      `监督 · 狭义推理 · 排除 ι×${excludeKeys.length}` +
        (decision.reasonSub === 'deepen' ? ' · 深化' : ' · 同问'),
    )
    const res = await askDeepSeekWithLetterDesk({
      question: runQ,
      packages: [pkg],
      bookIndex,
      docId,
      turnQueryKey: runQk,
      onProgress: input.onProgress,
    })
    return {
      ok: res.ok,
      answer:
        `### 监督 · 狭义推理轨\n${decision.why}\n排除：${excludeKeys.map((k) => `\`${k}\``).join(', ')}\n\n` +
        (res.answer || ''),
      note: `critique_reason · ${decision.reasonSub} · ${res.note}`,
    }
  }

  const bannedPaths = badPathsOf(decision)

  // ——— 预测 · 换问：新 qk 标准流（含 reuse）；旧框不继承 ———
  if (decision.predictSub === 'revise_q') {
    const newQ =
      decision.reviseQuestion?.trim() ||
      input.userText
        .replace(
          /^(请)?(换问|改问|重新问|换个问题|推翻问|问法不对|监督)[：:\s]*/i,
          '',
        )
        .trim() ||
      q
    if (!newQ || newQ === q) {
      useAttentionIo.getState().setDeskPrompt(
        '写信台 · 预测换问需要新的问句正文（与旧 Q 不同）。请给出改写后的问题。',
      )
      return {
        ok: false,
        answer: '',
        note: 'critique_predict · revise_q · 缺新问文',
      }
    }
    const newQk = st.ensureQueryKey(newQ)
    input.onProgress?.(
      `监督 · 预测换问 · 新 qk=${newQk} · 标准流（reuse 开；仍禁旧坏 path×${bannedPaths.length}）…`,
    )
    const flow = await runAutoFlow({
      question: newQ,
      bookIndex,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
      excludePathKeys: bannedPaths,
      decideCritiqueHint: decision.decideStrategyHint,
      excludeBriefKeys: decision.autopsy.dropBriefKeys,
    })
    return {
      ok: flow.ok,
      answer:
        `### 监督 · 预测轨 · 换问\n${decision.why}\n` +
        `旧 qk=\`${queryKey}\` → 新 qk=\`${newQk}\`\n` +
        `禁坏 path：${bannedPaths.map((k) => `\`${k}\``).join(', ') || '∅'}\n\n` +
        (flow.answer || flow.note),
      note: `critique_predict · revise_q · ${newQk} · ${flow.note}`,
    }
  }

  // ——— 预测 · 同问：先 decide；续流时禁坏 path，其它可 reuse ———
  const keep = new Set(decision.autopsy.keepBriefKeys)
  const drop = new Set(decision.autopsy.dropBriefKeys)
  let briefKeys =
    keep.size > 0
      ? [...keep]
      : st.queryKeyToBriefKeys[queryKey] ??
        listAllSettledBriefs(docId).map((b) => b.briefKey)
  if (decision.predictSub === 'drop_briefs' && drop.size > 0) {
    briefKeys = briefKeys.filter((b) => !drop.has(b))
  }
  if (briefKeys.length === 0) {
    briefKeys = listAllSettledBriefs(docId)
      .map((b) => b.briefKey)
      .filter((b) => !drop.has(b))
  }
  if (briefKeys.length === 0) {
    briefKeys = listAllSettledBriefs(docId).map((b) => b.briefKey)
  }

  const briefKey = briefKeys[0] || ''
  const bookKey =
    (briefKey && mapBriefToBook(docId, briefKey)?.bookKey) || ''

  const decideStartedAt = Date.now()
  const avoidProspectTexts = decision.autopsy.badProspectKeys
    .map((pk) => st.prospects.find((p) => p.prospectKey === pk)?.text)
    .filter((t): t is string => Boolean(t && t.trim()))
  const decidePkg: LetterDeskPackage = {
    id: sid(),
    edgeId: `critique_decide_${queryKey}`,
    bookKey,
    briefKey,
    question: q,
    job: 'decide',
    versionIndex: 0,
    createdAt: Date.now(),
    onlyBriefKeys: briefKeys,
    decideCritiqueHint: decision.decideStrategyHint,
    avoidProspectTexts:
      avoidProspectTexts.length > 0 ? avoidProspectTexts : undefined,
  }

  input.onProgress?.(
    `监督 · 预测轨 · ${decision.predictSub || 'reframe'} · decide…`,
  )
  const decideRes = await askDeepSeekWithLetterDesk({
    question: q,
    packages: [decidePkg],
    bookIndex,
    docId,
    turnQueryKey: queryKey,
    onProgress: input.onProgress,
  })

  const parts = [
    `### 监督 · 预测轨\n${decision.why}\n\n${decision.decideStrategyHint}\n\n`,
    decideRes.answer || '### decide · （空）',
  ]

  if (decision.predictSub === 'need_peek') {
    input.onProgress?.(
      `监督 · 预测轨 · 续自动流（禁坏 path×${bannedPaths.length}，其它可 reuse）…`,
    )
    const flow = await runAutoFlow({
      question: q,
      bookIndex,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
      excludePathKeys: bannedPaths,
      decideCritiqueHint: decision.decideStrategyHint,
      excludeBriefKeys:
        drop.size > 0 ? [...drop] : decision.autopsy.dropBriefKeys,
    })
    parts.push(
      `### 续自动流（禁坏 path，非禁一切 reuse）\n${flow.answer || flow.note}`,
    )
    return {
      ok: decideRes.ok || flow.ok,
      answer: parts.join('\n\n'),
      note: `critique_predict · need_peek · decide:${decideRes.note} · flow:${flow.note}`,
    }
  }

  // reframe / drop_briefs：先试「其它好 path」reuse；否则新 prospect 上 infer
  {
    const { runReuseGate } = await import('./letterDeskDispatch')
    const gate = await runReuseGate({
      qNow: q,
      docId,
      queryKey,
      excludePathKeys: bannedPaths,
      excludeNormKeys:
        useAttentionIo.getState().pendingReuseWait?.exhaustedNormKeys,
      onProgress: input.onProgress,
    })
    if (gate.awaitingMoreNorms) {
      parts.push(
        `### 复用停泊（监督）\n${gate.note}\n` +
          `awaiting=${(gate.awaitingHistoricQueryKeys ?? []).join(', ')}`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `critique_predict · ${decision.predictSub} · reuse_park · ${gate.note}`,
      }
    }
    if (gate.awaitingApproval) {
      parts.push(
        `### 同问复用提案挂起（已排除坏 path）\n${gate.note}\n` +
          `norms=${(gate.normKeys ?? []).join(', ')}`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `critique_predict · ${decision.predictSub} · reuse_await · ${gate.note}`,
      }
    }
    if (gate.adopted) {
      parts.push(
        `### 同问复用其它 path（已排除坏 path）\n${gate.note}\n` +
          `paths=${(gate.pathKeys ?? [gate.pathKey]).join(', ')}`,
      )
      return {
        ok: true,
        answer: parts.join('\n\n'),
        note: `critique_predict · ${decision.predictSub} · reuse_other · ${gate.note}`,
      }
    }
    parts.push(`### 其它 path 不可用\n${gate.note}`)
  }

  const fresh = freshProspectsForPredict(
    queryKey,
    decideStartedAt,
    decision.autopsy.badProspectKeys,
  )
  const excludeKeys = priorInferKeysForQuery(queryKey)
  if (fresh.length > 0 && excludeKeys.length > 0) {
    const pk = fresh[0]!
    const bk = mapBriefToBook(docId, pk.briefKey)?.bookKey || bookKey
    const inferPkg: LetterDeskPackage = {
      id: sid(),
      edgeId: `critique_infer_after_decide_${queryKey}`,
      bookKey: bk,
      briefKey: pk.briefKey,
      question: q,
      job: 'infer',
      versionIndex: 0,
      createdAt: Date.now(),
      excludeMode: 'B',
      excludeInferKeys: excludeKeys,
    }
    input.onProgress?.(
      `监督 · 预测轨 · 新 prospect ${pk.prospectKey} 上 infer（排除旧 ι×${excludeKeys.length}）…`,
    )
    const inferRes = await askDeepSeekWithLetterDesk({
      question: q,
      packages: [inferPkg],
      bookIndex,
      docId,
      turnQueryKey: queryKey,
      onProgress: input.onProgress,
    })
    parts.push(inferRes.answer || '### infer · （空）')
    return {
      ok: decideRes.ok && inferRes.ok,
      answer: parts.join('\n\n'),
      note: `critique_predict · ${decision.predictSub} · fresh=${pk.prospectKey} · ${decideRes.note} → ${inferRes.note}`,
    }
  }

  if (fresh.length === 0) {
    useAttentionIo.getState().setDeskPrompt(
      '写信台 · 预测轨 decide 未铸出可用新 prospect。可再说「材料不够」续 peek，或「换问」走 revise_q。',
    )
    parts.push(
      '### 预测轨收束\n本轮无新 prospect（或仍落在坏框上）；未自动 infer。',
    )
  } else if (excludeKeys.length === 0) {
    parts.push(
      '### 预测轨收束\n已有新 prospect，但无先验 ι 可排除；请确认匹配或单启 infer。',
    )
  }

  return {
    ok: decideRes.ok,
    answer: parts.join('\n\n'),
    note: `critique_predict · ${decision.predictSub} · ${decideRes.note}`,
  }
}
