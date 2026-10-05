# 实验分支：无 peek · prospect 顶替 brief 索引位

**分支**：`experiment/no-peek-prospect-as-index`  
**对照基线**：`main`（仍为 `peek → brief → decide → prospect`）

## 对照

| | `main`（现架构） | 本分支（实验） |
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

## 切回对照

```text
git checkout main          # peek 版
git checkout experiment/no-peek-prospect-as-index
```

本文件只存在于实验分支。
