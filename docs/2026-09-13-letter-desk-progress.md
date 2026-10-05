# 写信台进度备忘 · 2026-09-13

> **前端交互完成约 52%**，主路径（问→邻域→decide→infer→path）已能跑通；  
> **下一优先：继续完善 decide**（稳定性、早停、JSON 硬闸、问核选材）。

---

## 一、本轮已遇问题（导出审计）

| # | 现象 | 根因（简） | 状态 |
|---|---|---|---|
| 1 | 导出贴 Cursor 要再手工「编目录」 | 旧导出是纯时序流，无书 TOC / 分卷索引 | **已修**：导出含书目录快照 + 按工种/queryKey 分卷 |
| 2 | 复用停泊死等第二问 | 邻域历史问无 path/norm 仍被当成「待铸」 | **已修**：僵尸邻域不停泊；仅等有 path / pending 的活历史问 |
| 3 | 「放弃停泊·落入新铸」只写提示不跑流 | `onAbandonReuseWait` 未调 `runAutoFlow` | **已修**：放弃后 `skipReuse` 真开新铸 |
| 4 | 「如何批判弗洛伊德」≈「…的呢」拆成两 qk | 问句规范化过弱 | **已修**：去语气尾 `呢/吗/么/？` 等同问同键 |
| 5 | 复用失败后跨问剔 brief，弗洛伊德材料被掏空 | `excludeBriefKeys` 用了邻域旧问的 book | **已修**：仅剔本问 path 的 brief |
| 6 | 第二问 infer expand 后卡住、无 infer LLM | `runReuseGate` 只 re-export、本地未 import → `ReferenceError`；有邻域 path 时二次进闸必踩 | **已修**：正式 import + 注入依赖；autoFlow infer 包 `skipReuse` |
| 7 | 第三问（弗+拉比较）仍烧 reuse、全判 insufficient | query 已写「中高·仅一侧」，但仍无条件开 reuse | **已修**：query 硬闸 `reuseEligible`；未授权不烧 reuse，只喂 seed |
| 8 | query 空结果时「兜底含norm」冒充 neighbour | 绕过 query，伪授权复用前置 | **已修**：禁止兜底冒充 |
| 9 | 页图预取常「成功 0 · 失败 N」 | 审计球/页图物化失败（旁路） | **未修**（不挡主推理，但影响结算面看图） |
| 10 | decide 并行批大量「早停取消」/偶发 JSON 硬闸失败 | 触顶/并发与解析脆弱 | **部分可见**；属 decide 完善主线 |
| 11 | 半边 norm 无法「组合复用」答并列问 | 闸只逐条评、不评多 norm 合成 | **刻意暂缓**（先硬闸，后做微小可能） |

---

## 二、产品契约（已锁定要点）

| 环节 | 约定 |
|---|---|
| 问线 | 有历史 → **先 query**；无历史 → 直接新铸 |
| query | 出 `neighbours[{queryKey, degree, reuseEligible}]`；半边/中高/仅一侧 → `reuseEligible=false` |
| reuse | **仅当**至少一条 `reuseEligible=true`（或 degree 硬词：极高/同问深化/可整段复用）才开闸 |
| 材料 | 未授权 reuse 的邻域仍可喂 `seedBookKeys`，不借 conclusion |
| path → norm | 用户确认 path 才铸 norm；撤销不铸 |
| 导出 | 已分好类；含 toc_map 快照时 **勿再要求重跑目录向导** |

---

## 三、未来待办清单

### P0 · decide 完善（当前主攻）

- [ ] decide JSON 硬闸：解析失败重试 / 抢救策略统一，减少「无法解析 JSON」空转
- [ ] 并行批早停策略：触顶条件可解释、可审计（为何批 N 取消、可铸阈值是否过早）
- [ ] 问核选材与 TOC 走廊：命中率与误伤（专名撞词 vs 真解问）可观测
- [ ] decide 窗槽位与三态：unread 再入窗禁令、insufficient 禁 rationale 的违规率监控
- [ ] 导出/台账：decide 批结果摘要进分类目录（不必翻全流）

### P1 · 前端交互（目标：从 ~52% 拉高）

- [ ] 结算面：path 确认 / 撤销 / 复用提案 / 停泊提示的状态机一眼可读
- [ ] queryKey 画布与左栏审计持续对齐（选中、停泊、待批）
- [ ] 页图预取失败时的降级 UX（无图仍可确认 path，明确提示）
- [ ] 放弃停泊 / 批准复用后的进度条与可取消
- [ ] 近义问同键后的 UI 提示（「并入已有问」）

### P2 · query / reuse 深化（硬闸之后的「微小可能」）

- [ ] 多邻域 **组合复用**（弗+拉两侧都授权时合成答并列问）——仅在硬闸稳定后做
- [ ] degree 档位枚举化（极高/高/中/低）替代纯散文，减少解析漂移
- [ ] 同问深化 vs 换实体问的自动分型（query 输出 `relationKind`）
- [ ] 复用提案多 norm 勾选与部分批准

### P3 · 工程与可观测

- [ ] 语料包持久：目录确认后重开不必再跑 toc_map（若尚未稳定）
- [ ] 导出体积：分卷正文 vs 时序附录可选开关（减重复）
- [ ] 环依赖审计：`reuseGate` ↔ `letterDeskDispatch` 保持注入、禁裸 re-export 当本地符号

---

## 四、关键文件（本轮）

| 文件 | 作用 |
|---|---|
| `src/reasoning/queryReuseAuth.ts` | query→reuse 硬闸 |
| `src/reasoning/autoFlow.ts` | 阶段 A 后按授权决定是否 reuse；infer `skipReuse` |
| `src/reasoning/reuseGate.ts` | `onlyHistoricQueryKeys`；僵尸不停泊 |
| `src/reasoning/exportDeskLlmDump.ts` | 分类导出 + 书 TOC 快照 |
| `src/ui/QueryPathCurtain.tsx` | 放弃停泊真开新铸 |
| `src/arch/letterDeskContracts.ts` | query 契约含 `reuseEligible` |

---

## 五、建议下一测

1. 硬刷新 `http://127.0.0.1:5175/`
2. 问拉康 → 确认 path → 问弗洛伊德 → 确认 path  
3. 再问「是否提及弗与拉被比较批判」  
4. 导出检查：应有 query；**不应**再出现无授权的 reuse LLM；第三问走新铸 decide/infer
