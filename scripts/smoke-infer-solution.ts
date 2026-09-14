/**
 * Smoke: parseInferPaths + bindSolutions + settleInferPaths → 1 path / solution
 * Run: npx tsx scripts/smoke-infer-solution.ts
 */
import { parseInferPaths } from '../src/reasoning/inferPath'
import { bindSolutionsByBookLineage } from '../src/reasoning/pathLineageBind'
import { useAttentionIo } from '../src/reasoning/attentionIoStore'
import type { InferEdge, ProspectRecord } from '../src/reasoning/attentionIoStore'

function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(`FAIL: ${msg}`)
}

const newShape = `
\`\`\`json
{
  "paths": [
    {
      "conclusion": "三重打击批判拉康",
      "steps": [
        { "role": "清算力比多", "bookKeys": ["bk2"], "infer": "从门2推出清算" },
        { "role": "能指化", "bookKeys": ["bk3", "bk9"], "infer": "从门3+9推能指" }
      ]
    },
    {
      "conclusion": "配置替代结构",
      "steps": [
        { "role": "方法论", "bookKeys": ["bk4"], "infer": "陈述配置起点" }
      ]
    }
  ]
}
\`\`\`
`

const oldClimb = `
{
  "paths": [
    {
      "steps": [
        { "bookKeys": ["bk1"], "infer": "单门先验" },
        { "bookKeys": ["bk1","bk2"], "infer": "双门清算" },
        { "bookKeys": ["bk1","bk2","bk3"], "infers": ["说法A", "说法B"] }
      ]
    }
  ]
}
`

const parsed = parseInferPaths(newShape)
assert(parsed.length === 2, `new shape paths=${parsed.length}`)
assert(parsed[0]!.conclusion.includes('三重打击'), 'conclusion kept')
assert(parsed[0]!.steps.length === 2, 'steps=2')
assert(parsed[0]!.steps[0]!.role === '清算力比多', 'role kept')
assert(parsed[0]!.steps[1]!.bookKeys.join(',') === 'bk3,bk9', 'multi book')

const oldParsed = parseInferPaths(oldClimb)
assert(oldParsed.length === 1, 'old climb still parses')
assert(oldParsed[0]!.conclusion.includes('单门先验'), 'synth conclusion')
assert(oldParsed[0]!.steps.length === 4, `infers[] expands: got ${oldParsed[0]!.steps.length}`)

const edges: InferEdge[] = []
let seq = 1
parsed.forEach((path, pathIndex) => {
  const solutionKey = `sk_test_${pathIndex}`
  path.steps.forEach((step, stepIndex) => {
    edges.push({
      id: `e${seq}`,
      inferKey: `ik_${pathIndex}_${stepIndex}`,
      settleActionId: `st_${seq}`,
      contentFingerprint: `fp_${seq}`,
      bookKeys: step.bookKeys,
      fromBookKey: step.bookKeys[0]!,
      toBookKey: step.bookKeys[step.bookKeys.length - 1]!,
      infer: step.infer,
      rationale: step.infer,
      solutionKey,
      conclusion: path.conclusion,
      role: step.role,
      leftText: '',
      rightText: '',
      question: '如何批判拉康的呢',
      queryKey: 'qk_test',
      pathIndex,
      stepIndex,
      settleSeq: seq,
      createdAt: Date.now(),
    })
    seq++
  })
})

const prospects: ProspectRecord[] = [
  {
    prospectKey: 'pk_a',
    settleActionId: 'st_p1',
    briefKey: 'bk2',
    text: '预测清算',
    contentFingerprint: 'fp_p1',
    queryKey: 'qk_test',
    settleSeq: 1,
    createdAt: Date.now(),
  },
  {
    prospectKey: 'pk_b',
    settleActionId: 'st_p2',
    briefKey: 'bk3',
    text: '预测能指',
    contentFingerprint: 'fp_p2',
    queryKey: 'qk_test',
    settleSeq: 2,
    createdAt: Date.now(),
  },
  {
    prospectKey: 'pk_c',
    settleActionId: 'st_p3',
    briefKey: 'bk4',
    text: '预测配置',
    contentFingerprint: 'fp_p3',
    queryKey: 'qk_test',
    settleSeq: 3,
    createdAt: Date.now(),
  },
]

const bound = bindSolutionsByBookLineage({
  docId: 'doc_test',
  inferEdges: edges,
  prospects,
})
assert(bound.length === 2, `solutions bound=${bound.length} (not step×prospect)`)
assert(bound[0]!.prospects.length === 2, `path0 prospects=${bound[0]!.prospects.length}`)
assert(bound[1]!.prospects.length === 1, `path1 prospects=${bound[1]!.prospects.length}`)
assert(bound[0]!.bookKeysSequence.join(',') === 'bk2,bk3,bk9', `seq=${bound[0]!.bookKeysSequence.join(',')}`)

// hydrate edges into store to test listPathsForBookKeys (solution-level inferKeys)
useAttentionIo.setState({
  inferEdges: edges.map((e) => ({ ...e, queryKey: 'qk_list' })),
  paths: [
    {
      pathKey: 'ph_list_0',
      settleActionId: 'st_ph0',
      inferKey: edges[0]!.inferKey,
      prospectKey: '',
      queryKey: 'qk_list',
      matchMode: 'candidate',
      inferKeys: edges.filter((e) => e.solutionKey === 'sk_test_0').map((e) => e.inferKey),
      bookKeysSequence: ['bk2', 'bk3', 'bk9'],
      settleSeq: 1,
      createdAt: Date.now(),
    },
  ],
})
const listed = useAttentionIo.getState().listPathsForBookKeys(['bk9'])
assert(
  listed.some((p) => p.pathKey === 'ph_list_0'),
  'listPathsForBookKeys must hit via inferKeys[] not only primary inferKey',
)

// store settle
useAttentionIo.getState().clearAll()
const settled = useAttentionIo.getState().settleInferPaths({
  question: '如何批判拉康的呢',
  queryKey: 'qk_live',
  paths: parsed,
})
assert(settled.inferKeys.length === 3, `inferKeys=${settled.inferKeys.length}`)
const pending = useAttentionIo.getState().pendingPathMatch
assert(pending, 'pending exists')
assert(
  pending!.pathKeys.length === 2,
  `pathKeys should be 2 solutions, got ${pending!.pathKeys.length}`,
)
assert(
  pending!.boundPairs.length === 2,
  `boundPairs=${pending!.boundPairs.length}`,
)
assert(pending!.boundPairs[0]!.conclusion?.includes('三重'), 'pending conclusion')
assert(
  (pending!.boundPairs[0]!.steps?.length ?? 0) === 2,
  'pending steps',
)

const confirm = useAttentionIo.getState().settleUserPathMatches({
  queryKey: 'qk_live',
  pathKeys: [pending!.pathKeys[0]!],
})
assert(confirm.ok, confirm.note)
assert(confirm.normKeys.length === 1, `norms=${confirm.normKeys.length}`)
const norm = useAttentionIo.getState().norms.find((n) => n.normKey === confirm.normKeys[0])
assert(norm?.text.includes('三重打击'), `norm text=${norm?.text?.slice(0, 80)}`)

console.log('OK smoke-infer-solution')
console.log(
  JSON.stringify(
    {
      parsedPaths: parsed.length,
      inferKeys: settled.inferKeys.length,
      pendingPaths: pending!.pathKeys.length,
      normPreview: norm?.text.slice(0, 120),
    },
    null,
    2,
  ),
)
