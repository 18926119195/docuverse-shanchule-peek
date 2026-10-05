/**
 * 写信台递送有向边：上游哈希进来的 key ──► 本步递交给下一 LLM / 落账的 key。
 * 箭头尖 = toKey（递送目标）；箭尾 = fromKeys。
 */
export type DeskDeliveryJob =
  | 'peek'
  | 'query'
  | 'decide'
  | 'supervise'
  | 'infer'
  | 'reuse'

export type DeskDeliveryLink = {
  id: string
  job: DeskDeliveryJob
  /** 台为编本步递送而展开/哈希进来的 key */
  fromKeys: string[]
  /** 台本步递送（或落账产出）的 key */
  toKey: string
  stepId?: string
  settleSeq: number
  createdAt: number
}

export function deliveryId(job: string, toKey: string, seq: number): string {
  return `dd_${job}_${seq}_${toKey.slice(0, 24)}`
}
