/**
 * Role split for fan-out (追溯 / 复用的身份边界)：
 *
 * - Draft provider（草稿）：改写问句、向量/BM25/精排 → 只产出「可能相关的 key* 草稿名单」。
 *   不写入注入前提，不能单独进主推理。
 * - Letter writer（写信人 / 策略）：穷尽组合、提议 reuse|expand|尚未展开、定案。
 *   定追溯与复用的集合身份；仍不直接调主模型（先审再不跑）。
 * - Gateway（收信 / 唯一出口）：按定案执行 reuse / 新推，盖 ActionRecord 章。
 *   真正「记录注入」的是网关，不是写信人；登记随动作执行发生。
 * - Accept（采纳）：人认了之后铸资产身份 + 固化 pathMarker 回流。
 * - Reuse（复用）：同一 member_keys 组合已有采纳资产 → 网关短路，不调主模型。
 */

export type FanoutRole = 'draft' | 'letter' | 'gateway' | 'accept' | 'reuse'

export const FANOUT_ROLE_NOTE = {
  draft: '草稿：候选 key* 名单，非注入',
  letter: '写信台：组合穷尽 + 单元三态定案（先审再不跑）',
  gateway: '网关：按定案实喂/复用并记账',
  accept: '采纳：铸资产身份 + 路径标记回流',
  reuse: '复用：同槽组合已采纳，跳过主模型',
} as const
