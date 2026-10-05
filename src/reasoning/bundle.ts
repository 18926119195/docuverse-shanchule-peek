import type {
  DirectionRecord,
  InstructionBundle,
  IntrinsicCoordinate,
  ReasonEdge,
} from './types'

export function buildInferBundle(input: {
  R: IntrinsicCoordinate
  sourceExcerpt: string
  question: string
  forbid: DirectionRecord[]
  edge?: ReasonEdge
  premise?: InstructionBundle['premise']
}): InstructionBundle {
  const excerpt = input.sourceExcerpt.trim()
  if (!excerpt) {
    throw new Error('禁止打包：分析对象机器读值为空（未落到 A1 原子）')
  }
  if (!input.R.faces.text && !input.R.faces.fig) {
    throw new Error('禁止打包：位置锁缺少文字脸与图脸')
  }
  if (input.R.kind === 'text' && input.R.end <= input.R.start) {
    throw new Error('禁止打包：文字脸内禀坐标区间无效')
  }
  if (input.R.kind === 'fig' && !input.R.figId) {
    throw new Error('禁止打包：图主锁缺少 figId')
  }

  return {
    R: input.R,
    sourceExcerpt: excerpt,
    closureKey: input.R.key,
    question: input.question.trim(),
    forbidDirections: input.forbid.map((d) => ({
      directionId: d.directionId,
      questionSummary: d.questionText.slice(0, 80),
      conclusionSummary: d.conclusion.slice(0, 120),
    })),
    edge: input.edge,
    premise: input.premise,
    policy: {
      mustGroundToExcerpt: true,
      disallowOutsideR: true,
    },
    meta: {
      mode: 'infer',
      calledModel: true,
      at: Date.now(),
    },
  }
}

export function bundleToPrompt(_bundle: InstructionBundle): string {
  // Prompt templates live in api/_lib/protocol/prompt.ts (server-only).
  throw new Error(
    'bundleToPrompt 已迁至服务端 /api/protocol/infer，请勿在浏览器组装协议 prompt',
  )
}
