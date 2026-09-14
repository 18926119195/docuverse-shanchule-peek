/**
 * 轻量意图 → 写信台（§1.0.8 §7.5）
 * 第一步 = 未引入任何 LLM I/O；非第一步按 I/O 组合调度。
 */

import type { BookIndex } from './pipelineA'
import {
  useAttentionIo,
  type DeskJob,
  type LetterDeskPackage,
} from './attentionIoStore'
import { askDeepSeekWithLetterDesk } from './a1DsChat'
import { runAutoFlow } from './autoFlow'
import { LOCKED_LLM } from './modelRuntimeConfig'
import { loadDualModelConfig, reasonEndpointReady } from './modelRuntimeConfig'
import { demoAuthHeaders } from './demoAuth'
import { llmThinkingField } from './llmThinking'
import { useLlmIoStream, parseLlmUsage } from './llmIoStreamStore'

export type IntroducedIoKind =
  | 'none'
  | 'desk_packages'
  | 'selected_edge'
  | 'selected_infer'
  | 'selected_query'

export function detectIntroducedIo(): {
  kind: IntroducedIoKind
  packages: LetterDeskPackage[]
  inferKey: string | null
  queryKey: string | null
  edgeId: string | null
} {
  const s = useAttentionIo.getState()
  // 台包仍算引入；钉窗只看 pinnedAttention（打开选中 ≠ 钉住）
  if (s.deskPackages.length > 0) {
    const pin = s.pinnedAttention
    return {
      kind: 'desk_packages',
      packages: s.deskPackages,
      inferKey: pin?.kind === 'infer' ? pin.inferKey : null,
      queryKey: pin?.kind === 'query' ? pin.queryKey : null,
      edgeId: pin?.kind === 'edge' ? pin.edgeId : null,
    }
  }
  const pin = s.pinnedAttention
  if (pin?.kind === 'infer') {
    return {
      kind: 'selected_infer',
      packages: [],
      inferKey: pin.inferKey,
      queryKey: null,
      edgeId: null,
    }
  }
  if (pin?.kind === 'query') {
    return {
      kind: 'selected_query',
      packages: [],
      inferKey: null,
      queryKey: pin.queryKey,
      edgeId: null,
    }
  }
  if (pin?.kind === 'edge') {
    return {
      kind: 'selected_edge',
      packages: [],
      inferKey: null,
      queryKey: null,
      edgeId: pin.edgeId,
    }
  }
  return {
    kind: 'none',
    packages: [],
    inferKey: null,
    queryKey: null,
    edgeId: null,
  }
}
export type IntentAction =
  | { type: 'auto_flow'; question?: string; note?: string }
  | { type: 'dispatch'; packages: LetterDeskPackage[] }
  | { type: 'critique'; queryKey: string; note?: string }
  | { type: 'ask_user'; prompt: string }
  | { type: 'noop'; note: string }
  /** 调取注意力：按 llmCallId 批（或 jobs）召唤集合面板 */
  | {
      type: 'show'
      prompt: string
      llmCallIds?: string[]
      jobs?: string[]
    }

/**
 * 启发式只认「指令」；「是否问题」必须交意图 LLM，禁止用？/什么/如何 直接当 question。
 * undetermined = 未命中指令 → 占位 ask_user → refineIntentWithLlm。
 * 书内检索问交给意图 LLM（prompt 钉死 → auto_flow），勿被「看看/去看」误判成调显指令。
 */
export function classifyUtterance(
  userText: string,
): 'instruction' | 'undetermined' {
  const t = userText.trim()
  if (!t) return 'undetermined'
  // 书内检索 / 是否提到 → 一律交给意图 LLM（勿当 show / dispatch_query）
  if (
    /是否提到|有没有提到|书里有没有|文中是否|原文是否提到|bookkey.*是否|是否.*bookkey|去看.*是否/i.test(
      t,
    )
  ) {
    return 'undetermined'
  }
  // 指令：调显 / 单启工种 / 跳过匹配 / 匹配确认 / 监督归因口令
  if (
    /^(显示|打开|调取|展开|看看|只看)/.test(t) ||
    /请?(跑|启|开|执行|重跑)?\s*(peek|decide|infer|query|reuse|监督)/i.test(t) ||
    /单启|单独跑|只跑|跳过匹配|监督匹配|确认匹配|path\s*匹配|深化|收窄|监督归因|不满|换方向|换推|推理不对|预测不对|材料不够|换问|改问|问法不对/.test(
      t,
    ) ||
    /^(noop|通过)\s*$/i.test(t)
  ) {
    return 'instruction'
  }
  return 'undetermined'
}

function sid(): string {
  return `intent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`
}

/** 快速启发式（无选中包时）；迷糊 → ask_user */
export function heuristicIntent(input: {
  userText: string
  intro: ReturnType<typeof detectIntroducedIo>
}): IntentAction {
  const t = input.userText.trim()
  const lower = t.toLowerCase()
  const kind = classifyUtterance(t)

  if (input.intro.kind === 'none') {
    if (!t) return { type: 'ask_user', prompt: '请输入问题，或钉住某步 LLM 的 I/O 再调度。' }
    if (kind === 'instruction') {
      const st = useAttentionIo.getState()
      // path：有挂起时，「跳过匹配 / 监督匹配 / 纯“监督”」走同窝信效度，不走归因两轨
      if (
        st.pendingPathMatch &&
        (/跳过匹配|监督匹配/.test(t) || /^监督\s*$/.test(t))
      ) {
        return {
          type: 'ask_user',
          prompt:
            'path 已挂起：请在结算面「确认」或「撤销」。',
        }
      }
      // 监督归因：预测轨 vs 狭义推理轨（需台账已有 prospect/infer）
      // 不含光秃「监督」（上面已分流）；「监督归因 / 不满 / …」才归因
      if (
        /监督归因|归因|不满|推理不对|预测不对|材料不够|换方向|换推|换问|改问|问法不对/.test(t) ||
        (/监督/.test(t) && !/跳过匹配|监督匹配|^监督\s*$/.test(t))
      ) {
        const qk =
          st.pendingPathMatch?.queryKey ||
          st.selectedQueryKey ||
          (st.selectedInferKey
            ? st.inferEdges.find((e) => e.inferKey === st.selectedInferKey)
                ?.queryKey
            : undefined) ||
          Object.keys(st.settledQueries).slice(-1)[0]
        if (qk && (st.prospects.length > 0 || st.inferEdges.length > 0)) {
          return {
            type: 'critique',
            queryKey: qk,
            note: '监督归因 · 预测 vs 狭义推理',
          }
        }
        return {
          type: 'ask_user',
          prompt:
            '监督归因需要本问已有 prospect/infer。请先跑自动流，或钉住 query/infer。',
        }
      }
      // 单启某 LLM / 调显
      if (/跳过匹配|监督匹配/.test(t)) {
        return {
          type: 'ask_user',
          prompt:
            'path 已挂起：请在结算面「确认」或「撤销」。',
        }
      }
      if (/peek|铸贴/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_peek_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'peek',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/decide|决策/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_decide_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'decide',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/infer|推理|主推理/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_infer_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'infer',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/query|邻域|历史问/.test(t)) {
        return {
          type: 'dispatch',
          packages: [
            {
              id: sid(),
              edgeId: `cmd_query_${sid()}`,
              bookKey: '',
              briefKey: '',
              question: t,
              job: 'query',
              versionIndex: 0,
              createdAt: Date.now(),
            },
          ],
        }
      }
      if (/显示|调取|打开|展开/.test(t)) {
        // 口令调显：不猜具体批，交给 show 执行器 +（若需）意图 LLM 填 llmCallIds
        const jobHit: string[] = []
        if (/brief|peek|门贴/.test(t)) jobHit.push('peek')
        if (/prospect|decide|决策/.test(t)) jobHit.push('decide')
        if (/infer|推理|ι/.test(t)) jobHit.push('infer')
        if (/path|路径/.test(t)) jobHit.push('path')
        if (/neighbour|邻域|query/.test(t)) jobHit.push('query')
        if (/reuse|复用/.test(t)) jobHit.push('reuse')
        return {
          type: 'show',
          prompt: `指令·调显：${t.slice(0, 120)}`,
          jobs: jobHit.length ? jobHit : undefined,
        }
      }
      return {
        type: 'ask_user',
        prompt:
          '识别为指令。请说明要：调显某内容，或单启 peek / decide / infer / query；path 可「确认匹配」或「跳过匹配」。',
      }
    }
    // 非指令：禁止正则当问题进 auto_flow；占位后由 refineIntentWithLlm 判定
    return {
      type: 'ask_user',
      prompt:
        '待意图判定：这是问题（走自动流）还是指令？未命中指令口令，须意图 LLM 确认后才能 auto_flow。',
    }
  }

  // 已确认写信台包 = 已引入 I/O + 已定 job → 直接投递
  if (input.intro.kind === 'desk_packages') {
    return { type: 'dispatch', packages: input.intro.packages }
  }

  const rerun =
    /重跑|重来|不对|不满|错了|再试|重新/.test(t) || /retry|again|wrong/.test(lower)
  const advance =
    /继续|推进|下一步|够了|满意|确认|提交/.test(t) || /next|enough|ok/.test(lower)
  const otherDir =
    /另一|别的方向|换路|多方向|不要这条|排除这条|换条路/.test(t)
  const justLook = /看看|只看|没事|通过|noop/.test(t) && t.length < 12

  if (justLook || (!t && !rerun)) {
    return { type: 'noop', note: '人工监督 · noop（未发调度指令）' }
  }

  if (input.intro.kind === 'selected_infer') {
    const ik = input.intro.inferKey!
    const edge = useAttentionIo
      .getState()
      .inferEdges.find((e) => e.inferKey === ik)
    if (!edge) {
      return { type: 'ask_user', prompt: '选中的 inferKey 已失效，请重新点开 ι。' }
    }
    // 不满/材料/预测 → 统一进监督两轨；仅明确「换推/排除这条」才直跳玩法 B
    const wantCritique =
      /监督归因|归因|不满|推理不对|预测不对|材料不够|框错|不够|换方向|换问|改问|问法不对/.test(
        t,
      ) ||
      (/不对|错了|重来|重新|重跑|再试/.test(t) &&
        !/换推|排除这条|换条路|另一/.test(t))
    if (wantCritique) {
      return {
        type: 'critique',
        queryKey: edge.queryKey,
        note: '钉ι · 监督归因（预测 vs 狭义推理）',
      }
    }
    if (otherDir || /换推|排除这条|换条路/.test(t)) {
      const pkg: LetterDeskPackage = {
        id: sid(),
        edgeId: edge.id,
        bookKey: edge.fromBookKey,
        briefKey: '',
        question: t || edge.question,
        job: 'infer',
        versionIndex: 0,
        createdAt: Date.now(),
        excludeMode: 'B',
        excludeInferKeys: [ik],
      }
      return { type: 'dispatch', packages: [pkg] }
    }
    return {
      type: 'ask_user',
      prompt:
        '已钉住推理结果。请说明：材料/预测不对（监督归因），还是换推/排除这条，或满意推进？',
    }
  }

  if (input.intro.kind === 'selected_query') {
    const parentQk = input.intro.queryKey!
    // 深化：钉住旧问后给出更具体问句 → 子 qk → auto_flow（可跳过 decide）
    if (/深化|收窄|更具体/.test(t)) {
      const deepText =
        t
          .replace(/^(请)?(深化|收窄|更具体)(问句|问题|一下|这题)?[：:\s]*/i, '')
          .trim() || t
      const childQk = useAttentionIo.getState().ensureDeepenedQueryKey({
        parentQueryKey: parentQk,
        question: deepText,
      })
      const childQ =
        useAttentionIo.getState().settledQueries[childQk] || deepText
      return {
        type: 'auto_flow',
        question: childQ,
        note: `深化 · child=${childQk} ← parent=${parentQk}`,
      }
    }
    if (advance || rerun || t) {
      const pkg: LetterDeskPackage = {
        id: sid(),
        edgeId: `qk_${input.intro.queryKey}`,
        bookKey: '',
        briefKey: '',
        question: t || useAttentionIo.getState().settledQueries[input.intro.queryKey!] || '',
        job: 'query',
        versionIndex: 0,
        createdAt: Date.now(),
      }
      return { type: 'dispatch', packages: [pkg] }
    }
    return {
      type: 'ask_user',
      prompt:
        '已钉住 queryKey。可：重跑阶段 A；或说「深化：…」收窄问法（子 qk，可跳过 decide）。',
    }
  }

  // selected_edge：Δ brief/book 窗
  if (input.intro.kind === 'selected_edge' && input.intro.edgeId) {
    const edge = useAttentionIo
      .getState()
      .edges.find((e) => e.id === input.intro.edgeId)
    if (!edge) {
      return { type: 'ask_user', prompt: '选中的注意力边已失效。' }
    }
    let job: DeskJob = 'decide'
    if (rerun) job = 'decide'
    if (/peek|铸贴|换贴|再贴/.test(t)) job = 'peek'
    if (/主推理|infer|路径/.test(t)) job = 'infer'
    if (/阶段\s*a|历史问|排序/.test(t)) job = 'query'
    if (!t && !rerun && !advance) {
      return {
        type: 'ask_user',
        prompt:
          '已钉住 LLM I/O 窗。请说明：不满 in/out 要重跑哪步，或满意推进下一步？',
      }
    }
    const pkg: LetterDeskPackage = {
      id: sid(),
      edgeId: edge.id,
      bookKey: edge.fromKey,
      briefKey: edge.toKey,
      question: t || '',
      job,
      versionIndex: 0,
      createdAt: Date.now(),
    }
    return { type: 'dispatch', packages: [pkg] }
  }

  return {
    type: 'ask_user',
    prompt: '说不清意图。请说明盯的是哪步 I/O 的 in 还是 out，以及要重跑还是推进。',
  }
}

/**
 * 可选：轻量意图 LLM。
 * 启发式仅能认指令；非指令一律先 ask_user，由本函数判定 question→auto_flow。
 * 失败 / 端点未就绪 → 保持 ask_user，禁止正则兜底进自动流。
 */
export async function refineIntentWithLlm(input: {
  userText: string
  intro: ReturnType<typeof detectIntroducedIo>
  heuristic: IntentAction
}): Promise<IntentAction> {
  if (input.heuristic.type !== 'ask_user') return input.heuristic
  if (!input.userText.trim()) return input.heuristic

  const { reason } = loadDualModelConfig()
  if (!reasonEndpointReady(reason)) {
    return {
      type: 'ask_user',
      prompt:
        input.heuristic.type === 'ask_user'
          ? input.heuristic.prompt + '（意图端点未就绪，无法判定是否为问题。）'
          : '意图端点未就绪，无法判定是否为问题。',
    }
  }

  const base = (reason.baseUrl.trim() || '/api/llm').replace(/\/$/, '')
  const systemContent =
    `你是轻量意图路由（写信台前置 · 会话 epoch=${useAttentionIo.getState().intentSessionEpoch}）。` +
    '先判 instruction|question。意图路由 ≠ 监督归因(critique)：你只做调度前置，不审 prospect/infer。' +
    '【硬规则】只有你判定为 question 时才能输出 auto_flow；禁止因「？/什么/如何」等表面特征由代码代判。' +
    '【书内内容问】对当前书的问句一律 auto_flow，包括：「是否提到X」「书里有没有X」「如何批判/批评X」「怎么理解X」「X是什么意思」等。' +
    '【禁止把「批判」当 critique】用户话里的「批判/批评某人」是书内论题/检索问 → auto_flow；' +
    'critique 仅当用户要监督已落账推演（不满/推理不对/预测不对/材料不够/监督归因），且台账已有 prospect 或 infer。' +
    '台账空 / 可调取进度边目录空 / intro=none 时：禁止 critique，也禁止因「批判像监督」而 ask_user → 一律 auto_flow。' +
    '不要因为「可调取进度边目录」为空就 ask_user（目录空只表示还没跑过工种，正该 auto_flow 去 decide）。' +
    '【禁止误路由】dispatch_query 只用于「历史问邻域 / 阶段A / neighbour」，不是全文检索「是否提到某人」。' +
    'instruction→单启 peek/decide/infer/query、监督归因(critique)、调显(show)或跳过匹配。' +
    'show：仅当用户要「调取/显示/打开已落账面板」时；从「可调取进度边目录」选 1～3 个 llmCallId（或 jobs）。' +
    '只输出 JSON：{"action":"auto_flow"|"critique"|"dispatch_decide"|"dispatch_peek"|"dispatch_query"|"dispatch_infer"|"skip_path_match"|"ask_user"|"noop"|"show","llmCallIds":["lc_…"],"jobs":["peek"|"decide"|"infer"|"query"|"reuse"|"path"],"note":"…"}。' +
    '【禁止】输出 attentionArrived / attentionReady（那是 peek/decide/infer 窗材料到位字段，意图路由无本窗材料）。' +
    '仅「换推/排除这条」可直跳 dispatch_infer；有 pending 时跳过匹配/监督匹配/纯监督 → skip_path_match（监督在已铸 pathKey 上评信效度并铸 normKey）。' +
    '真说不清（指令与问句无法分辨）才 ask_user；禁止把书内内容问拆成 auto_flow vs critique 二选一追问。不写 keep/路径/brief；不翻库；不把意图记录当成注意力窗 I/O。'
  const userContent = [
    `意图会话 epoch：${useAttentionIo.getState().intentSessionEpoch}`,
    `引入 I/O 类型：${input.intro.kind}`,
    `inferKey：${input.intro.inferKey ?? '∅'}`,
    `queryKey：${input.intro.queryKey ?? '∅'}`,
    `可调取进度边目录：\n${await (async () => {
      const { formatCallCatalogForIntent } = await import(
        './intentShowSummon'
      )
      return formatCallCatalogForIntent(
        input.intro.queryKey ?? undefined,
      )
    })()}`,
    `用户话：${input.userText}`,
  ].join('\n')
  try {
    const res = await fetch(`${base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...demoAuthHeaders(),
      },
      body: JSON.stringify({
        model: reason.model || LOCKED_LLM.chatModel,
        temperature: 0,
        // 意图路由 = 分类填槽，不开 reasoning
        ...llmThinkingField('disabled'),
        messages: [
          {
            role: 'system',
            content: systemContent,
          },
          {
            role: 'user',
            content: userContent,
          },
        ],
      }),
    })
    if (!res.ok) {
      useLlmIoStream.getState().pushLlmIo({
        job: 'intent',
        stage: 'route',
        queryKey: input.intro.queryKey ?? undefined,
        ok: false,
        note: `HTTP ${res.status}`,
        system: systemContent,
        user: userContent,
        output: '',
      })
      return input.heuristic
    }
    const data: unknown = await res.json()
    const usage = parseLlmUsage(data)
    const content =
      typeof data === 'object' &&
      data &&
      'choices' in data &&
      Array.isArray((data as { choices: unknown }).choices)
        ? (data as { choices: Array<{ message?: { content?: string } }> })
            .choices[0]?.message?.content
        : undefined
    if (typeof content !== 'string') {
      useLlmIoStream.getState().pushLlmIo({
        job: 'intent',
        stage: 'route',
        queryKey: input.intro.queryKey ?? undefined,
        ok: false,
        note: '无 content',
        usage,
        system: systemContent,
        user: userContent,
        output: '',
      })
      return input.heuristic
    }
    useLlmIoStream.getState().pushLlmIo({
      job: 'intent',
      stage: 'route',
      queryKey: input.intro.queryKey ?? undefined,
      ok: true,
      usage,
      system: systemContent,
      user: userContent,
      output: content,
    })
    // 意图路由无「本窗材料」：禁止 deskMonitorAttentionArrival，否则 LLM 顺手写
    // attentionArrived=false 会误刷「注意力未到位」提示，盖住真正的调取/调度结果。
    const m = content.match(/\{[\s\S]*\}/)
    if (!m) return input.heuristic
    const obj = JSON.parse(m[0]) as {
      action?: string
      note?: string
      llmCallIds?: string[]
      jobs?: string[]
    }
    const action = String(obj.action ?? '')
    const note = String(obj.note ?? '')
    // 台账空时：禁止把书内「批判」问拆成 critique / ask_user；意图只是写信台前置
    const ledgerEmpty =
      input.intro.kind === 'none' &&
      !input.intro.inferKey &&
      !input.intro.queryKey
    if (
      ledgerEmpty &&
      (action === 'critique' ||
        (action === 'ask_user' &&
          /critique|监督|归因|auto_flow|批判/.test(note)))
    ) {
      return {
        type: 'auto_flow',
        note: '台账空 · 书内内容问 → auto_flow（意图≠critique）',
      }
    }
    // 书内检索靠 system prompt 钉 auto_flow；禁止硬改写 ask_user/dispatch_query/show，
    // 否则会架空「调显已有边 / 阶段A neighbour / 真需追问」等合法路由。
    if (action === 'auto_flow') return { type: 'auto_flow' }
    if (action === 'critique') {
      return heuristicIntent({
        userText: '监督归因',
        intro: input.intro,
      })
    }
    if (action === 'noop')
      return { type: 'noop', note: note || 'noop' }
    if (action === 'show')
      return {
        type: 'show',
        prompt: note || '调显',
        llmCallIds: Array.isArray(obj.llmCallIds)
          ? obj.llmCallIds.map(String)
          : undefined,
        jobs: Array.isArray(obj.jobs) ? obj.jobs.map(String) : undefined,
      }
    if (action === 'skip_path_match')
      return { type: 'ask_user', prompt: '跳过匹配' } // runComposerTurn 见 pending 后真跑信效度
    if (action === 'ask_user')
      return {
        type: 'ask_user',
        prompt: note || input.heuristic.prompt,
      }
    // map dispatch_* back through heuristic with synthetic text
    if (action === 'dispatch_infer_B' && input.intro.inferKey) {
      return heuristicIntent({
        userText: '换方向 排除这条',
        intro: input.intro,
      })
    }
    if (action.startsWith('dispatch_')) {
      const raw = action.replace('dispatch_', '')
      const job = (raw === 'mainInfer' ? 'infer' : raw) as DeskJob
      const synth =
        job === 'peek'
          ? '再 peek'
          : job === 'query'
            ? '阶段A'
            : job === 'infer'
              ? 'infer'
              : '重跑决策'
      return heuristicIntent({ userText: synth, intro: input.intro })
    }
  } catch (e) {
    useLlmIoStream.getState().pushLlmIo({
      job: 'intent',
      stage: 'route',
      queryKey: input.intro.queryKey ?? undefined,
      ok: false,
      note: e instanceof Error ? e.message : 'intent route failed',
      system: systemContent,
      user: userContent,
      output: '',
    })
    /* fall through */
  }
  return input.heuristic
}

export async function runComposerTurn(input: {
  question: string
  bookIndex: BookIndex
  onProgress?: (msg: string) => void
  sealItems: Parameters<typeof runAutoFlow>[0]['sealItems']
}): Promise<{ ok: boolean; answer: string; note: string }> {
  const intro = detectIntroducedIo()
  const epoch = useAttentionIo.getState().intentSessionEpoch
  const qRaw = input.question.trim()

  let intent = heuristicIntent({ userText: input.question, intro })
  if (intent.type === 'ask_user' && qRaw) {
    input.onProgress?.(
      `意图路由 · 轻量 LLM（会话 epoch=${epoch}）…`,
    )
    intent = await refineIntentWithLlm({
      userText: input.question,
      intro,
      heuristic: intent,
    })
  }

  // 深化 auto_flow 已铸子 qk；监督归因用 intent.queryKey；其余路径再 ensure 根/同文键
  const flowQuestion =
    intent.type === 'auto_flow' && intent.question?.trim()
      ? intent.question.trim()
      : intent.type === 'critique'
        ? useAttentionIo.getState().settledQueries[intent.queryKey] || qRaw
        : qRaw
  const turnQueryKey =
    intent.type === 'critique'
      ? intent.queryKey
      : flowQuestion
        ? useAttentionIo.getState().ensureQueryKey(flowQuestion)
        : ''

  // 空位补增量交 auto_flow / 因果序写信台；不再二次意图 LLM

  useAttentionIo.getState().pushIntentDeskLog({
    question: flowQuestion || input.question,
    action: intent.type,
    note:
      intent.type === 'ask_user'
        ? intent.prompt
        : intent.type === 'noop'
          ? intent.note
          : intent.type === 'show'
            ? intent.prompt
            : intent.type === 'critique'
              ? `critique · qk=${intent.queryKey}` +
                (intent.note ? ` · ${intent.note}` : '')
              : intent.type === 'dispatch'
                ? `dispatch×${intent.packages.length} · qk=${turnQueryKey}`
                : `auto_flow · qk=${turnQueryKey} · epoch=${epoch}` +
                  (intent.note ? ` · ${intent.note}` : ''),
  })

  // path 信效度须先于 ask_user 早退（启发式对「跳过匹配」会先 ask_user 提示）
  if (
    useAttentionIo.getState().pendingPathMatch &&
    (/跳过匹配|监督匹配/.test(input.question) ||
      /^监督\s*$/.test(input.question.trim()))
  ) {
    input.onProgress?.('写信台 · 跳过手工确认 → 监督铸 norm…')
    const { skipPendingPathMatchToSupervise } = await import(
      './letterDeskDispatch'
    )
    const r = await skipPendingPathMatchToSupervise({
      onProgress: input.onProgress,
    })
    return {
      ok: (r.normKeys?.length ?? 0) > 0 || r.pathKeys.length > 0,
      answer: `### 监督\n${r.note}\npathKeys: ${r.pathKeys.map((k) => `\`${k}\``).join(', ')}\nnormKeys: ${(r.normKeys ?? []).map((k) => `\`${k}\``).join(', ') || '∅'}`,
      note: r.note,
    }
  }

  if (intent.type === 'ask_user') {
    useAttentionIo.getState().setDeskPrompt(`写信台 · ${intent.prompt}`)
    return { ok: false, answer: '', note: `ask_user · ${intent.prompt}` }
  }
  if (intent.type === 'noop') {
    return { ok: true, answer: '', note: intent.note }
  }
  if (intent.type === 'show') {
    // 已有 jobs/ids 则直接执行；否则再让意图从目录点名
    let showIntent = intent
    if (
      !(intent.llmCallIds && intent.llmCallIds.length > 0) &&
      !(intent.jobs && intent.jobs.length > 0) &&
      reasonEndpointReady(loadDualModelConfig().reason) &&
      qRaw
    ) {
      input.onProgress?.('意图路由 · 调取哪些进度边…')
      const refined = await refineIntentWithLlm({
        userText: input.question,
        intro,
        heuristic: {
          type: 'ask_user',
          prompt: '调取注意力',
        },
      })
      if (refined.type === 'show') {
        showIntent = {
          type: 'show',
          prompt: refined.prompt || intent.prompt,
          llmCallIds: refined.llmCallIds,
          jobs: refined.jobs,
        }
      }
    }
    const { planShowSummon, executeShowSummon } = await import(
      './intentShowSummon'
    )
    const plan = planShowSummon({
      llmCallIds: showIntent.llmCallIds,
      jobs: showIntent.jobs,
      note: showIntent.prompt,
      queryKey: turnQueryKey || undefined,
    })
    const r = executeShowSummon(plan)
    return {
      ok: r.ok,
      answer: r.note,
      note: `show · ${r.note}`,
    }
  }

  if (intent.type === 'critique') {
    input.onProgress?.(`监督归因 · qk=${intent.queryKey}…`)
    const { runSuperviseCritique } = await import('./superviseCritique')
    const { executeSuperviseCritique } = await import('./superviseCritiqueExec')
    const decision = await runSuperviseCritique({
      queryKey: intent.queryKey,
      userText: input.question,
      onProgress: input.onProgress,
    })
    return executeSuperviseCritique({
      decision,
      queryKey: intent.queryKey,
      bookIndex: input.bookIndex,
      userText: input.question,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
    })
  }

  if (intent.type === 'auto_flow') {
    return runAutoFlow({
      question: flowQuestion,
      bookIndex: input.bookIndex,
      onProgress: input.onProgress,
      sealItems: input.sealItems,
    })
  }

  // dispatch（空位单步或显式指令）
  const packages = intent.packages.map((p) => ({
    ...p,
    question: p.question.trim() || flowQuestion,
  }))
  return askDeepSeekWithLetterDesk({
    question: flowQuestion,
    packages,
    bookIndex: input.bookIndex,
    docId: input.bookIndex.docId,
    turnQueryKey: turnQueryKey || undefined,
    onProgress: input.onProgress,
  })
}
