/**
 * Generate a minimal 2-page PDF fixture (Helvetica / ASCII text layer).
 * Run: node scripts/gen-intuition-pdf.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(__dirname, '..', 'fixtures')

const lines1 = [
  'Intuition Probe — Page 1',
  'User intuition: unconscious cues guide first judgments.',
  'Claim A: A flash of insight often precedes formal proof.',
  'Claim B: Retrieving near passages can expand that flash.',
  'Task: verify whether the flash matches the cited text.',
]

const lines2 = [
  'Intuition Probe — Page 2',
  'Extension: contrast nearby sentences across pages.',
  'Possible inference: insight is a compressed path mark.',
  'Reuse: same slots + near question should not re-roll.',
  'Deferred: other combos wait as not-yet-expanded.',
]

function escapePdfText(s) {
  return s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
}

function contentStream(lines) {
  const parts = []
  let y = 750
  for (const line of lines) {
    parts.push(`BT /F1 11 Tf 50 ${y} Td (${escapePdfText(line)}) Tj ET`)
    y -= 22
  }
  return parts.join('\n')
}

function obj(n, body) {
  return `${n} 0 obj\n${body}\nendobj\n`
}

const c1 = contentStream(lines1)
const c2 = contentStream(lines2)

const objs = [
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>'),
  obj(2, '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>'),
  obj(
    3,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 5 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  ),
  obj(
    4,
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>',
  ),
  obj(5, `<< /Length ${c1.length} >>\nstream\n${c1}\nendstream`),
  obj(6, `<< /Length ${c2.length} >>\nstream\n${c2}\nendstream`),
  obj(7, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
]

let pdf = '%PDF-1.4\n'
const offsets = [0]
for (const o of objs) {
  offsets.push(Buffer.byteLength(pdf, 'latin1'))
  pdf += o
}
const xrefStart = Buffer.byteLength(pdf, 'latin1')
pdf += `xref\n0 ${objs.length + 1}\n`
pdf += '0000000000 65535 f \n'
for (let i = 1; i <= objs.length; i++) {
  pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
}
pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\n`
pdf += `startxref\n${xrefStart}\n%%EOF\n`

fs.mkdirSync(outDir, { recursive: true })
const pdfPath = path.join(outDir, 'intuition-probe.pdf')
fs.writeFileSync(pdfPath, pdf, 'latin1')
fs.writeFileSync(
  path.join(outDir, 'README.md'),
  `# Intuition Probe PDF

File: \`intuition-probe.pdf\` (2 pages, text layer).

## Upload
1. Open Docuverse upload
2. Check **PDF 有可用文字层** (skip OCR)
3. Wait for embed/index ready

## Seed question
> Does a flash of insight precede formal proof, and can nearby passages expand that flash?

## What to feel
Your gut after reading page 1 vs what the model cites and concludes; then expand cross-page and reuse.
`,
  'utf8',
)
console.log('wrote', pdfPath)
