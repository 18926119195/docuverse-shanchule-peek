import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../', import.meta.url))
const server = await createServer({ root, configFile: false, envFile: false, server: { middlewareMode: true, watch: null, ws: false } })
try {
  const load = (path) => server.ssrLoadModule('/src/' + path + '.ts')
  const { scheduleStrandsHeadTailThenMiddle } = await load('data/pdfPagePipeline')
  const { buildA1GlobalExport } = await load('reasoning/a1DsExport')
  const { gateNounsAgainstBatchText } = await load('arch/bookNounS1Dictation')
  const { shortDenseScore } = await load('arch/qCoreBookHits')
  const { parseDeskSlotIndex } = await load('arch/windowAlias')
  const { normalizeIncrementStatus } = await load('arch/keyIncrementStatus')
  const schedule = scheduleStrandsHeadTailThenMiddle(50)
  assert.deepEqual([schedule.head.length, schedule.tail.length, schedule.middle.length], [8, 8, 34])
  assert.equal(new Set([...schedule.edges, ...schedule.middle]).size, 50)
  const full = '完整正文用于验证导出。'.repeat(250)
  const result = buildA1GlobalExport({ docId: 'fixture', chunks: [
    { key: 'door2', kind: 'text', faces: {}, content: '一段长度足够的第二页文本', page: 1, slotK: 0, bbox: [0, 0, 100, 100] },
    { key: 'door1', kind: 'text', faces: {}, content: full, page: 0, slotK: 0, bbox: [0, 0, 100, 100] },
  ] })
  assert.equal(result.filenameBase, 'a1-ds_fixture_GLOBAL')
  assert.equal(result.rows[0].T, full)
  assert.deepEqual(result.rows.map((row) => row.key), ['door1', 'door2'])
  const gate = gateNounsAgainstBatchText(['lacan', 'Freud', 'Jacques █'], '本批中出现 Lacan。')
  assert.deepEqual(gate.accepted, ['Lacan'])
  assert.deepEqual(gate.rejected.map((r) => r.reason), ['not_substring', 'noise'])
  assert.ok(shortDenseScore('Lacan Lacan', 2).score > shortDenseScore('Lacan ' + 'else '.repeat(50), 1).score)
  assert.equal(parseDeskSlotIndex('⟦1⟧'), 1)
  assert.equal(parseDeskSlotIndex('w1'), null)
  console.log(JSON.stringify({ ocrBands: [8, 8, 34], a1Rows: result.rows.length, fullTextChars: full.length,
    nounGate: gate.rejected.map((row) => row.reason), shortDense: 'pass', windowAlias: 'pass' }))
  assert.deepEqual(['不充分', '不够用', 'not enough', '充分', '未读'].map(normalizeIncrementStatus),
    ['insufficient', 'insufficient', 'insufficient', 'sufficient', 'unread'])
  console.log('increment status: pass')
} finally {
  await server.close()
}
