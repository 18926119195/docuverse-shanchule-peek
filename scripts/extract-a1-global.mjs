/**
 * Extract A1 KEY+T from a .docuverse.json corpus pack into ONE global file.
 * Full text (no 1200 clip), no pack splits.
 */
import fs from 'node:fs'
import path from 'node:path'

const CORPUS_KIND = 'docuverse-corpus'

function atomSearchText(c) {
  const text = c.faces?.text?.content?.trim()
  if (text && text.length >= 8) return text
  const raw = String(c.content ?? '').trim()
  if (raw && !raw.startsWith('[FIG:') && raw.length >= 8) return raw
  if (text) return text
  const note = String(c.faces?.fig?.note ?? '').trim()
  return note
    .replace(/请依据可见版面回答[^。]*。?/g, '')
    .replace(/勿编造未提供的文字[^。]*。?/g, '')
    .replace(/无文字层\/未OCR[^。]*。?/g, '')
    .trim()
}

function isRetrievableAtom(c) {
  const t = atomSearchText(c)
  if (t.length < 4) return false
  if (c.kind === 'fig' && t.length < 24 && !c.faces?.text) return false
  return true
}

function sortChunks(chunks) {
  return [...chunks].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page
    const dy = a.bbox[1] - b.bbox[1]
    if (Math.abs(dy) > 8) return dy
    return a.bbox[0] - b.bbox[0] || a.slotK - b.slotK
  })
}

function safeDocSlug(docId) {
  return (
    String(docId)
      .replace(/^upload:/, '')
      .replace(/[^\w\u4e00-\u9fff.-]+/g, '_')
      .slice(0, 48) || 'doc'
  )
}

function a1DsPromptRules() {
  return [
    '【任务规则 · 必须遵守 · peek 契约】',
    '1. 下面是 A1 表：每行只有 KEY（= bookKey / 门牌）与 T（原文）。',
    '2. 只能从 KEY 列原样复制门牌，禁止编造、截断、改写 KEY。',
    '3. LLM out = 同一 bookKey + brief 正文；禁止输出 briefKey / queryKey / inferKey；禁止 items[] / keep[] / 整窗 coverage。',
    '   briefKey 由写信台落账铸造，模型不要写。',
    '   主协议 briefs[]：一元素一槽；同门多贴 = 多条同 key，或一行 briefs:["贴A","贴B"] 展开。',
    '   仅 sufficient（或有 brief 未报态）才铸键；unread/insufficient 不铸。',
    '4. brief = 门贴标签，必须用「名词 + 动词/关系」电报体，禁止完整陈述句。',
    '   - 格式：对象·动作｜关系（可用 · ｜ / 连接）；尽量短。',
    '   - 优先沿用 T 原文中的关键措辞立贴。',
    '5. rationale 可写半句「为何对问题有用」，勿把 brief 写成小作文。',
    '6. 输出 JSON（可包在 ```json 里）：',
    '   {"briefs":[{"key":"h1.…","brief":"名词·动词｜关系","status":"sufficient"},{"key":"h1.…","briefs":["贴A","贴B"],"status":"sufficient"}],"keyStatuses":[{"key":"h1.…","status":"unread|sufficient|insufficient"}],"answer":"可选总述"}',
    '7. briefs[].key 必须与表中 KEY 字符级完全一致；brief 必填非空；同 KEY 多槽勿合并成一条。',
    '8. 对每个输入 bookKey 报三态：unread=未读；sufficient=brief 充分可铸可递送；insufficient=已读但贴不够。',
    '9. 本批 KEY 看不清或证据不足：该 KEY 标 insufficient/unread，仍尽量对能读的 KEY 铸 brief；禁止空 briefs[] 并要求「请分批输入」（分批由台侧完成）。',
  ].join('\n')
}

function renderMarkdownGlobal(rows, meta) {
  const rules = a1DsPromptRules()
  const head = [
    `# A1 · KEY + T（全局一份）`,
    ``,
    `source: ${meta.label}`,
    `docId: ${meta.docId}`,
    `rows: ${rows.length} · fullText: true · packs: 1/1`,
    ``,
    rules,
    ``,
    `---`,
    ``,
  ].join('\n')
  const body = rows
    .map((r) => [`KEY: \`${r.key}\``, `T:`, r.T, ''].join('\n'))
    .join('\n')
  const foot = [
    ``,
    `---`,
    ``,
    rules,
    ``,
    `请根据用户问题，只从上面 KEY 中选择，输出 JSON。`,
    ``,
  ].join('\n')
  return head + body + foot
}

function collectRows(chunks) {
  const rows = []
  let dropped = 0
  for (const c of sortChunks(chunks)) {
    if (!isRetrievableAtom(c)) {
      dropped += 1
      continue
    }
    const T = atomSearchText(c)
    if (T.trim().length < 4) {
      dropped += 1
      continue
    }
    rows.push({ key: c.key, T })
  }
  return { rows, dropped }
}

function main() {
  const inputPath = process.argv[2]
  const outDir = process.argv[3] || path.dirname(inputPath)
  const fmt = (process.argv[4] || 'both').toLowerCase() // md | jsonl | both
  if (!inputPath) {
    console.error(
      'Usage: node extract-a1-global.mjs <corpus.docuverse.json> [outDir] [md|jsonl|both]',
    )
    process.exit(1)
  }
  const abs = path.resolve(inputPath)
  const raw = JSON.parse(fs.readFileSync(abs, 'utf8'))
  if (raw.kind !== CORPUS_KIND) {
    throw new Error(`不是语料包 kind=${raw.kind}`)
  }
  if (!raw.bookIndex?.chunks || !Array.isArray(raw.bookIndex.chunks)) {
    throw new Error('缺少 bookIndex.chunks')
  }

  const { rows, dropped } = collectRows(raw.bookIndex.chunks)
  const slug = safeDocSlug(raw.docId || raw.label || 'doc')
  const base = `a1-ds_${slug}_GLOBAL`
  const meta = {
    label: raw.label || slug,
    docId: raw.docId || '',
  }

  const written = []
  if (fmt === 'md' || fmt === 'both') {
    const mdPath = path.join(outDir, `${base}.md`)
    fs.writeFileSync(mdPath, renderMarkdownGlobal(rows, meta), 'utf8')
    written.push(mdPath)
  }
  if (fmt === 'jsonl' || fmt === 'both') {
    const jsonlPath = path.join(outDir, `${base}.jsonl`)
    const jsonl = rows.map((r) => JSON.stringify({ key: r.key, T: r.T })).join('\n')
    fs.writeFileSync(jsonlPath, jsonl, 'utf8')
    written.push(jsonlPath)
  }

  const totalChars = rows.reduce((n, r) => n + r.T.length, 0)
  console.log(
    JSON.stringify(
      {
        ok: true,
        input: abs,
        label: meta.label,
        docId: meta.docId,
        chunksTotal: raw.bookIndex.chunks.length,
        rowsExported: rows.length,
        dropped,
        totalTChars: totalChars,
        written,
      },
      null,
      2,
    ),
  )
}

main()
