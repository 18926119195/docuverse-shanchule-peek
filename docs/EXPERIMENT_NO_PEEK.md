# 实验分支：无 peek · prospect 顶替 brief 索引位

**实验分支**：`experiment/no-peek-prospect-as-index`（本仓库默认分支）

**对照基线**：[docuverse-kanzheli 的 040a9bb](https://github.com/18926119195/docuverse-kanzheli/tree/040a9bb)（`peek → brief → decide → prospect`）

## 对照

| | 对照基线 | 本分支（实验） |
|--|------------------|----------------|
| 冷启 | peek LLM 铸 brief（骨架 bookKey） | **无 peek LLM**；骨架 bookKey **直接入 decide 队列** |
| 材料压缩层 | brief（挂 book） | **废除**；decide 直读 book+T |
| decide 输入 | `{briefKey, brief}` | `{bookKey, T}` |
| prospect 父键 | briefKey | **bookKey**（落账字段仍叫 `briefKey`，语义=材料父门） |
| 热启 | seedRange → peek 再铸 brief | seedRange → **把书序 bookKey 并入 decide 队列**（再 decide） |
| reuse / 剔材料 | 剔 path 用过的 brief | 剔 path 用过的 **bookKey**（同一字段） |
| infer 血缘 | prospect → brief → book | prospect → **book**（父键即 book） |

## 预测 vs 推理（本分支刻意保留）

- **prospect**：在候选 book 上框「可能怎样回答 Q」（选材 + 假设）  
- **infer**：在已选 book 的 T 上写具体 ι（证明）  
- **path** = infer × prospect；监督两轨仍可拆 predict / reason_narrow  

二者输入同为 book+T+Q 时，靠**工种职责**防重复，不靠 brief 中间层。

## 获取对照版本

```text
git clone https://github.com/18926119195/docuverse-kanzheli.git
git -C docuverse-kanzheli switch --detach 040a9bb
```

本仓库的 `main` 初始提交与默认实验分支的初始提交使用同一棵源码树。本表讨论自动流程，手动 peek 仍可通过 harness 入口调用。
