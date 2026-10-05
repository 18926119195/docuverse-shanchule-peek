/**
 * DeepSeek V4 默认会开 thinking。写信台默认一律显式关掉（见 chat-archive
 * `2026-09-08-thinking-full-off-measured.md`）：
 *   半开 decide/infer 时 infer 常被 reasoning 吃光 max_tokens → content 空、ι 落不成；
 *   全关后同题更省（~83k→~33k）且链路跑通。
 * 关 ≠ 不会推理：只是不单独吐可计费的 reasoning_content，一次正向生成 content。
 * 若日后某工种真要开，在调用点传 thinking: true / llmThinkingField('enabled')。
 */
export type LlmThinkingMode = 'enabled' | 'disabled'

export function llmThinkingField(
  mode: LlmThinkingMode = 'disabled',
): { thinking: { type: LlmThinkingMode } } {
  return { thinking: { type: mode } }
}

/** 写信台工种默认关 reasoning（含 decide / infer） */
export function thinkingForJob(_job?: string): LlmThinkingMode {
  return 'disabled'
}
