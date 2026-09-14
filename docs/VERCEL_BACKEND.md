# Vercel 后端托管说明（协议进服务端）

> 目标：求职 demo 可点效果；**内禀坐标工程（铸键 / 排放 / 闭包规则）与上游 Key 不在浏览器包内**。  
> 浏览器只拿密封句柄 `h1.…`，**真 lockId 不出站**。  
> 推理锁定 **DeepSeek-V4-Pro**；OCR 锁定智谱 **glm-ocr**。  
> **Vercel 生产：** `vite build` 关闭 sourcemap、minify、drop console——Sources 里看不到 `intrinsicKey.ts` 等源文件名；协议规则仍只在 `api/`。  
> Network 仍可见效果层（摘录、绿框几何、`h1`）；`emit-page` 线上响应已去掉 `slotK`/字符区间字段。  
> 日期：2026-08-20

## 架构

```text
浏览器（薄 UI）
  · PDF / 绿框 / 提问
  · POST /api/protocol/emit-page  → slots[].handle（密封）
  · POST /api/protocol/mint-key   → combo/slot/fig 密封句柄
  · POST /api/protocol/closure    → 以 handle 为房钥匙
  · POST /api/protocol/infer
  · /api/zhipu/* · /api/llm/*

服务端
  · 铸 lockId → AES-GCM 封成 h1.…（HANDLE_SECRET）
  · 组合键先 unseal 成员再 makeComboKey 再 seal
```

## 句柄 vs 门牌

| 浏览器可见 | 服务端持有 |
|------------|------------|
| `h1.` + base64url(密文) | `doc\|slot\|p…\|k…` 等 lockId |
| 摘录 / 绿框几何 | 铸键公式、闭包阈值、prompt |

确定性 IV：同一 lockId 始终封成同一 handle（冷启动也可解）。

## 环境变量

| 变量 | 必需 | 说明 |
|------|------|------|
| `HANDLE_SECRET` | 强烈建议 | 密封句柄密钥；缺省回退 `DEMO_ACCESS_TOKEN` / 开发占位 |
| `ZHIPU_API_KEY` | OCR | 智谱 |
| `LLM_API_KEY` | 推理/向量 | 上游 |
| `DEMO_ACCESS_TOKEN` | 公开站 | 门禁 |
| `VITE_DEMO_ACCESS_TOKEN` | 与上一致 | 请求头 |

**不要**设置 `VITE_LLM_API_KEY` / `VITE_OCR_API_KEY`。

## 本地

1. `.env` 填密钥；建议设 `HANDLE_SECRET`。  
2. `npm run dev`：Vite 插件覆盖全部 `/api/protocol/*`。

## 安全预期

| 项 | 结果 |
|----|------|
| 真 lockId | 不进 Network JSON |
| 铸键 / 闭包规则 | 仅 `api/_lib/protocol/` |
| 句柄字符串 | F12 可见但不可读（无 secret 不可解） |
| 摘录文本 | 演示必需，仍可见 |
