/**
 * peek 专用指令（≠ 用户 Q_now 任务句）。
 * 冷启：书进窗材料前置（骨架 brief，类 embedding）；只固定指令，不附用户原话。
 * 热启/修贴（已有 brief）：固定指令 + 用户原话旁注；扩中间区间。
 */
export const PEEK_BRIEF_INSTRUCTION =
  '指令：从各门 T 原文严谨提炼 brief 门贴。' +
  'brief 只能是名词、专有名词或动词（及「名词·动词｜关系」电报体）；' +
  '禁止完整陈述句；禁止把用户问题当 brief；' +
  '对每个输入 bookKey 报 status：unread|sufficient|insufficient。'

/** 热启 peek 在冷启指令上的附加约束 */
export const PEEK_HOT_INSTRUCTION_SUFFIX =
  '仅在书序给定区间内扩搜铸贴；已开门勿无故重铸；' +
  '仅当 T 相对缺口仍需补标签时才输出该 KEY。'

/** 第二次+ peek：用户原话仅作旁注（修贴意图），仍禁止写进 brief */
export const PEEK_USER_ASIDE_HINT =
  '【用户原话·旁注】下面是用户本次说法，只用于理解要改/补哪类贴；' +
  '禁止把原话整句抄进 brief；brief 仍须贴 T 电报体。'
