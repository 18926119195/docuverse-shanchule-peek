/**
 * 写信台契约表：job → allow/forbid + in/out 协议（正文不变，仅调度）。
 * 对齐：对称 key 出入 + 增量落账（方案 B settle）；正文指纹不当门牌。
 * 各工种 out 必须带输入 key 的增量三态：unread | sufficient | insufficient。
 */

import type { DeskJob } from '../reasoning/attentionIoStore'
import { keyStatusContractHint } from './keyIncrementStatus'

export type ContractKeyKind =
  | 'briefKey'
  | 'bookKey'
  | 'queryKey'
  | 'inferKey'
  | 'prospectKey'
  | 'pathKey'
  | 'normKey'

export interface DeskContract {
  job: DeskJob
  /** 本窗允许出现的门牌型（expand 只准产出这些） */
  allow: ContractKeyKind[]
  forbid: ContractKeyKind[]
  inNote: string
  outNote: string
}

export const DESK_CONTRACTS: Record<DeskJob, DeskContract> = {
  peek: {
    job: 'peek',
    allow: ['bookKey'],
    forbid: [],
    inNote:
      'bookKey（划重点铸门）+ T；layout 默信铸门，强调笔命中复用 / 未覆盖须确认再铸；' +
      '共享 page_norm 基底（同级 peer）',
    outNote:
      'briefs[{key, brief|briefs[], status}] + keyStatuses；' +
      'key 回传本窗 ⟦n⟧；同 bookKey 多 brief = 多槽（多条或 briefs:["A","B"] 展开），台各 settle 铸 briefKey；' +
      '仅 sufficient 铸键；items[]/keep[] 已废除；' +
      keyStatusContractHint('bookKey'),
  },
  query: {
    job: 'query',
    allow: ['queryKey'],
    forbid: ['bookKey', 'briefKey'],
    inNote:
      '历史问族槽 ⟦n⟧+Q（含根与深化子问；排除 Q_now）+ Q_now（阶段 A · 无 brief）',
    outNote:
      'neighbours[{queryKey:⟦n⟧, degree, reuseEligible}]（对称子集 + 相关度 + 是否授权 reuse）；' +
      'reuseEligible=true 仅当该历史问的已有 path/norm 能完整回 Q_now（同问深化/极高/可整段复用）；' +
      '中高、半边、仅一侧、只可迁移方法论 → reuseEligible=false（仍可进 neighbours 喂材料）；' +
      '台为每条 settle neighbourKey 挂在该 historic queryKey 上；' +
      '只许回传 ⟦n⟧；' +
      keyStatusContractHint('queryKey'),
  },
  decide: {
    job: 'decide',
    /** 实验：直读 book；prospect 父门=bookKey（落账字段仍写 briefKey） */
    allow: ['bookKey'],
    forbid: ['briefKey'],
    inNote:
      '【实验·无 peek】Q_now + 材料槽 ⟦n⟧（独占行）+ T；prospect 挂 book（字段名 briefKey:=bookKey）',
    outNote:
      'prospects[{bookKey|briefKey, prospect|prospects[], status, relevance}] + keyStatuses；' +
      '门牌只许回传本窗 ⟦n⟧；台展开为全长 bookKey；多种可能=多槽各 settle；' +
      '【prospect 仅 sufficient】仅「能直接支撑解 Q_now」才输出/铸 prospectKey（父=bookKey）；' +
      'relevance 必填 1–5（对 Q 的解问相关度，非专名撞词分）；台侧 ≥3 才进 infer；' +
      'unread/insufficient 禁止写 prospect，只记 status；' +
      '【rationale 闸】insufficient 一律禁止 rationale；普通轮 keyStatuses 只报三态；' +
      '曾报 unread 再进窗：禁止再 unread；sufficient 须 rationale，insufficient 仍禁止 rationale；' +
      '【解问·正例】批评/拒斥/清算/替代 Freud 的概念装置 → sufficient + prospect + relevance；' +
      '【解问·反例】仅点名/标题/临床旁例 → insufficient，禁止因专名硬铸；' +
      '专名命中≠充分，也≠默认不足；逐门独立判断，禁止整窗一刀切；' +
      '原文能直接给出一种解 Q 角度 → sufficient + prospect + relevance；' +
      'insufficient 时可给 seedRange（端点=窗外邻域槽/bookKey，禁止整窗自覆盖）→ 台展开为 seedBookKeys；' +
      '可选 stopReason:"expand" + seedRange/seedRanges（端点=目录或窗内 ⟦n⟧，可半开）；' +
      '台晚执行：toc_nav 端点视为已读目录；正文轮锚点须已读；闭集展开为 seedBookKeys 再 decide（不调 peek）；' +
      keyStatusContractHint('bookKey'),
  },
  supervise: {
    job: 'supervise',
    allow: ['pathKey'],
    forbid: [],
    inNote:
      '台已铸候选 path 以 ⟦n⟧ 分槽（血缘绑定 infer×prospect）；展开 ι∥prospect 正文；' +
      '用户未 tick、也未自整理时进本工种：信效度+写出归一化正文，台铸 normKey',
    outNote:
      'judgments[{pathKey:⟦n⟧,status,normalizedText}]：sufficient→台铸 normKey（infer 为底、prospect 修饰）；' +
      'insufficient 不铸；禁止输出未绑定槽；只许回传 ⟦n⟧；' +
      '对照：用户 tick 时台直接把 path 内容登记为 norm（可自带整理文），不经本 LLM；' +
      keyStatusContractHint('pathKey'),
  },
  infer: {
    job: 'infer',
    allow: ['bookKey'],
    forbid: [],
    inNote:
      '材料槽 ⟦n⟧(+T) + Q_now；可选玩法B排除：inferKey+ι原文（钉ι换方向）；' +
      'reuse失败不向infer塞旧问法——只在decide前剔path用过的briefKey',
    outNote:
      'paths[{conclusion, steps[{role?, bookKeys, infer}]}] + materialStatus/keyStatuses；' +
      '【读门】须认真读完本窗每个 bookKey/T；充分才写 infer，不充分只报 insufficient（禁止硬写）；' +
      '【infer→conclusion】先有能支撑解 Q 的逐步 infer，再写出这些 infer 如何排列/组合形成 conclusion（直接回答如何解 Q）；' +
      '【组合非强制】仅当读完后发现若干门/若干 infer 能一起解 Q 才合并进同一步或同一 path；' +
      '能单门成步就单门；不能拼凑就不要硬并；禁止为凑结构做 1门→2门→3门 爬梯，也禁止机械「一门一步扫完窗」；' +
      '【多门一步】bookKeys≥2 时 infer 须：各 ⟦n⟧ 分述（与 bookKeys 门牌一致）+【合推】说明诸门如何共同完成本步；' +
      '每条 path=一种解法总览；steps=该总览的论证溯源；多解法=多条 paths（主轴须可区分）；' +
      '台：每步铸 inferKey；整条 path 铸一个候选 pathKey；bookKeys 回传 ⟦n⟧；' +
      '【rationale 闸】insufficient 禁止 rationale；sufficient 可写短 rationale；' +
      '用户确认 path→normKey，或跳过→监督铸 normKey；' +
      keyStatusContractHint('bookKey'),
  },
}

export function lookupContract(job: DeskJob): DeskContract {
  return DESK_CONTRACTS[job]
}
