# 入库指南 · 无 peek 自动流与证据回溯

核验基线为 [experiment/no-peek-prospect-as-index · e4c42b8](https://github.com/18926119195/docuverse-shanchule-peek/commit/e4c42b846f843764fab0f6010efa2d10c000a17f)，2026-11-19。

## 从哪里接手

本库研究自动流用 `bookKey` 直入 decide、以本问的 prospect 定位 infer 材料后，结论路径是否仍可逐项回查。手动 peek 工具仍可调用。和带 peek 的 [kanzheli 对照仓](https://github.com/18926119195/docuverse-kanzheli) 比较时，首要任务是把自动分支、入模门牌和预算记录成可复跑证据。

| 要确认的环节 | 入口 |
| --- | --- |
| 用户问题如何触发自动流 | [intentDeskRouter.ts](src/reasoning/intentDeskRouter.ts) → [autoFlow.ts](src/reasoning/autoFlow.ts) → [harnessGateway.ts](src/reasoning/harnessGateway.ts) |
| 槽号和结论怎样回到材料 | [windowAlias.ts](src/arch/windowAlias.ts) · [pathLineageBind.ts](src/reasoning/pathLineageBind.ts) |
| 导入、分批与 A1 导出 | [PdfUploadPanel.tsx](src/ui/PdfUploadPanel.tsx) · [pdfPagePipeline.ts](src/data/pdfPagePipeline.ts) · [全局导出](src/reasoning/a1DsExport.ts) |
| 名词表与历史 | [S₁ 默写模块](src/arch/bookNounS1Dictation.ts) · [原始对话目录](docs/chat-archive/) · [NP-01–NP-07](DEVELOPMENT_HISTORY.txt) |

```sh
npm ci --ignore-scripts
npm run build
npm run check:system
npm run dev
```

Node 24.22.1 下构建与 [离线检查](scripts/check-system.mjs) 通过。观测到 50 页夹具拆分 8／8／34、两条 A1 样本含完整 2,750 字长文本，词表硬闸拒收非本批和噪声候选，窗内别名、词面排序与增量三态通过。供应商容量、早停、真实 OCR 与部署需独立联调。

## 从原话到代码

早期设计归档集中进入 [2026-09-14 快照 b85b839](https://github.com/18926119195/docuverse-shanchule-peek/commit/b85b8399f8a23fc57b66a02d5c4ab3023ffba364)。下表日期来自对话，详细引文和源码版本见 [开发时间线](DEVELOPMENT_HISTORY.txt)。

| 时间（北京时间） | 意图与状态 | 证据 |
| --- | --- | --- |
| 09-10 | 用户要求先处理固定头尾页。此分支采用头尾各 8 页，会等头尾齐备后开放目录及中段处理。 | [OCR 对话](docs/chat-archive/2026-09-10-bookkey-ocr-ingest-pipeline-9175a123.jsonl#L118) · [调度源码](src/data/pdfPagePipeline.ts) |
| 09-11 | 冷启自动流先 decide 再按 prospect 血缘送 infer，需要时扩材料。仍需通过贯穿入口的桩测试记录早停、无效门牌和重试。 | [无 peek 对话](docs/chat-archive/2026-09-11-no-peek-decide-infer-735a6aee.jsonl) · [自动流](src/reasoning/autoFlow.ts) |
| 09-12 至 09-13 | 回溯真正送进主推理的槽，按 steps 绑定候选路径。窗内别名和新旧结论格式具备模块验证。 | [回溯对话](docs/chat-archive/2026-09-12-material-search-optimization-11b9f5ca.jsonl#L56) · [路径对话](docs/chat-archive/2026-09-13-ui-interaction-and-search-strategy-d1aa470d.jsonl#L207) · [路径夹具](scripts/smoke-infer-solution.ts) |
| 09-14 | 用户要求全局合并导出 A1，现已进导入界面。S₁ 默写、回配、硬闸是模块原型。尚无从正常问答入口到该模块的调用证据。 | [A1 与默写对话](docs/chat-archive/2026-09-14-book-noun-pipeline-a1-global-44215623.jsonl#L6) · [A1 导出](src/reasoning/a1DsExport.ts) · [S₁ 原型](src/arch/bookNounS1Dictation.ts) |

## 下一项工作 · 复跑同题的两条自动流

用钱学森《工程控制论》的反馈思想，将材料边界当作受控状态，将证据覆盖、调用预算和无法回溯的 key 当作观测量。

1. 取同一份最小语料、问句和返回桩。给两臂固定同一 OCR 页集合和模型设置，基线保留一题材料充足和一题需扩窗的输入。逐轮记录入口、路由、prospect、实际送模键、返回键、三态、结论 path、耗时及调用次数。
2. 首先只验本库。冷启自动路径首个相关步骤是 decide，infer 用本问 prospect；应接受合法窗内别名并拒收不可回查的证据。覆盖一次材料充足直接结束与一次不足扩窗，记录停止原因。调用次数或扩窗次数越过源码上限时暂停并复查路由。
3. 以相同控制变量跑 kanzheli，对比时序中的工具调用和送模键差分。两边任何路径无法对齐到输入材料时回退至上一基线，并保存最小失败日志。由维护者确认词表模块要充当哪一环输入后，再单独修改 S₁ 接入，防止同一次实验更换两个变量。
4. PR 附 NP-02／NP-03、两臂提交与输入哈希、预算、反例与复验结果。把已验行为回写到相应 NP 条目。Engram 和内部过程先验仍以研究假设登记。

## 方法依据

本指南把总体设计落实为边界、目标和任务接口，把工程控制中的反馈落实为观测、判据和纠偏。维护者用原始协作记录、代码和固定样本共同核验定性判断与量化结果，据此决定下一轮行动。[《工程控制论》](https://openlibrary.org/books/OL49218199M/Engineering_cybernetics) · [《组织管理的技术——系统工程》](https://doi.org/10.13255/j.cnki.jusst.2011.06.020) · [《一个科学新领域——开放的复杂巨系统及其方法论》](https://cnki.istiz.org.cn/kcms/detail/detail.aspx?dbcode=CPFD&dbname=cpfd1999&filename=ZGXC199008001001)
