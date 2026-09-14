# 架构演进记录（Architecture Evolution）

专门记录「我的架构」相对旧实现的变化线。不写操作手册；只记**共识转折**与**为何弃旧**。

目标架构（人脸/机器脸·时空·过程先验）：见 [`docs/新架构模型.md`](./新架构模型.md)。

源聊天：`docs/chat-archive/2026-09-03-architecture-align.jsonl`（会话 `20490f7c-…`）及后续续聊。

---

## 时间线

### 2026-09-03 · 内禀坐标与 LLM 对称性

- **内禀坐标**：空间 = book/page；时间 = layout/ocr/peek 等步骤。decide **批调用 ≠ 共享坐标**。
- **对称性**：各 LLM 同型 key 出入（输出 ⊆ 输入）+ 增量落账挂在被选中的输出 key 上。
- **prospect**：与 brief 一一对应；一次 decide 吐 N 条 = N 次落账，不共享「第几次 decide」。
- **path**：infer × prospect 匹配后落 `pathKey`。
- **reuse**：输入 path + 展开(infer∥prospect)；经 query→neighbour 找旧问线上的 path——**不是**正文像不像。

### 2026-09-03 · 方案 B（落账微动作铸键）

- 主键锁在**写信台单次 settle**，不锁正文哈希。
- 正文指纹 `fp_*` 仅副索引；**不参与 reuse、不当可调取门牌**。
- 意图导航要的是「任务图空位地址」→ settle 实例键。

### 2026-09-03 · 纠正

- 字段名不得再叫 `briefContentHash` 塞实例键 → 正式 `briefKey`。
- prospect ≠ rationale（rationale 仅「为何 keep」）。
- path：**先用户匹配**；只有显式跳过才监督 LLM（不在 infer 落账后自动配）。
- neighbour 挂在**被选中的历史 queryKey** 上，不是挂在 Q_now。

### 2026-09-03 · 增量三态（给写信台递送）

每个 LLM 对**窗内每个输入 key**报：

| 状态 | 含义 |
|---|---|
| 未处理（unread） | 没读到 / 没轮到 |
| 充分（sufficient） | 已为该 key 产出够用的增量 → 可递送下游 |
| 不充分（insufficient） | 读了但增量不够 → 补材料 / 换工种 |

**不是**旧的 decide `coverage`，也不是 `attentionArrived`。

### 2026-09-04 · 拍板与清理

| 议题 | 决定 |
|---|---|
| path 僵局（一直 pending） | **搁置到 path UI** 再定交互 |
| 同问 ↔ queryKey | **同问同线**：复用同一 `queryKey`；不满只改环节，不另开 qk |
| 多种可能 | **多条 prospectKey**：台对每个可能各 settle 一次 |
| 意图 | **要上空位导航**（缺什么增量 → 调哪个键 / 哪工种） |
| fanout 指纹 combo reuse | **删除**（见下） |
| peek 与用户话 | **冷启/首次 peek 不带 Q**；仅用户主动「补/改 brief」时带其诉求 |

### 2026-09-04 · peek 同门多槽

- **曾有 bug**：`a1DsChat` 按 bookKey 去重，同门多条 `items` 只留第一条。
- **现**：允许同一 bookKey 多输出槽（多条 items 或 `briefs[]`）；每槽 `rollDoorBrief` → 独立 `briefKey`，全部挂该门（新头 + history）。


- 删除 `llmRetrieve`（LLM 选廊 `sectionIds` / 选门 `keys`）
- 删除 `queryExpand`（问句扩词 `terms`）
- 检索漏斗仅保留：目录锁廊 / `rankSections`（BM25 节级）+ 域内/全书 BM25

主工种 LLM 仍为：peek / query / decide / infer / supervise / reuse 闸 / intent。


**旧线**：材料组合指纹（`findReusableForCombo` / archive fingerprint）→ 判能否跳过推理。

**为何废**：新架构 reuse 已是 `neighbour → 旧 query 线 → path`；两套都叫 reuse 会串台，且旧线不绑问线门牌。

**现码**：

- `letterDesk.findReusableForCombo` 恒 `null`
- fanout 策略默认 `force_expand`；UI 去掉「优先复用」
- 问线复用只认 `runReuseGate` / `adoptReusePath`（path 坐标）

FanoutHud 仍可做「穷尽组合 → 新推/尚未展开」；**不再**做指纹复用。

---

## 台如何精准落多条 prospect（2026-09-04）

问题：多种可能时，台怎么「找到对应信息」铸成 key？

**答案：不搜内容；只认结构化回传。**

1. 窗内 briefKey 清单是**允许集**（台发出去的门牌）。
2. decide 必须**字符级回传** `briefKey`（可多行同 brief，或 `prospects: []`）。
3. 台逐行：`briefKey ∈ 允许集` 且 `prospect` 非空 → `settleOnce` → 新 `prospectKey` 挂该 brief。
4. 不在允许集 / 缺正文 → **拒收**，不瞎配最近似 brief。

精准性来自协议硬闸，不是语义检索。

---

## 待做（相对共识仍缺）

1. 同问复用同一 `queryKey`（改 `ensureQueryKey`）
2. 意图空位导航协议
3. peek：冷启剥 Q / 用户补 peek 才带诉求
4. path 匹配 UI（交互另议）
5. 单启 decide/query 也走 settle（不只 autoFlow）

---

## 关键词对照（旧 → 新）

| 旧 | 新 |
|---|---|
| 正文哈希当 brief/infer/query 主键 | settle 实例键；指纹仅副索引 |
| decide `keep.rationale` 当预测 | `prospect`；rationale 可选 |
| infer 后默认监督配 path | pending → 用户匹配 / 显式跳过才 LLM |
| fanout 指纹 combo reuse | **已废**；neighbour→path |
| 每次开口新 queryKey | **应**同问同 qk（待改码） |
| mainInfer 中心叙事 | 工种名 **infer**（job id 可暂留兼容） |
