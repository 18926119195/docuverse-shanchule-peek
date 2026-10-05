# 进度备忘 · 2026-09-14

> 名词表建库链路（S₀→残文→S₁ 默写）与 Engram/过程先验对照；A1 改为全局一份全文导出。

## 已落地

| 项 | 说明 |
|----|------|
| A1 全局导出 | UI/脚本固定单文件 `*_GLOBAL`，全文不截断、不拆包；兼容上传语料包 |
| S₁ 默写 | 残文分批、本批连续子串硬闸、整串 ignore-case 去重（禁最长吞并） |
| 材料面 | 抽词/默写只喂纯 `T`；`collectPlainTexts`；删备用 `chunkResidual*` / locs |
| 跨 S₀ 切口 | `priorNouns` 前缀重叠（含 █）；硬闸拒含 █ 的抄写 |
| 对齐拼接 | `joinResidualBatchText` 禁止 trim/filter，保 S₀ 间隙偏移 |

## 开放（最新任务）

- **建表末 `attachBookKeysByLocate` 判多余**：建库产物拟停在 `{ text }[]`；locate 延后到问核圈出相关名词后再做。尚未改码。

## 对照结论（Engram 会话）

- Engram = N-gram **哈希查表** → 静态内容记忆注入残差（`h←h+Y`）；不是过程路径复用。
- 名词表 = 书上内容单元寻址（更动态、钉 `bookKey`）；与 Engram **同族不同层**，≠ 过程先验。
- 过程先验仍要：门牌键（query/path）+ Q/结论验收闸 +（远期）轨迹指纹/`v`。

## 归档

- `docs/chat-archive/2026-09-14-book-noun-pipeline-a1-global-44215623.jsonl`
- `docs/chat-archive/2026-09-14-deepseek-engram-process-prior-4852a46c.jsonl`
- `docs/book-noun-pipeline-protocol-2026-09-14.md`
