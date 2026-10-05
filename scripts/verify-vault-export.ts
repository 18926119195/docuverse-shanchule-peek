/**
 * Smoke: vault write-through → buildCorpusPack prefers vault over missing imageUrl.
 * npx tsx scripts/verify-vault-export.ts
 */
import {
  clearPageImageVault,
  stashPageImageDataUri,
  vaultSize,
  peekPageImageDataUri,
} from '../src/data/pageImageVault'
import { buildCorpusPack } from '../src/data/corpusPack'
import type { PageDocument } from '../src/zigzag/types'
import type { OcrPageResult } from '../src/data/ocrService'

clearPageImageVault()
const tiny = 'data:image/jpeg;base64,/9j/4AAQ'
for (const s of [0, 14, 18]) stashPageImageDataUri(s, tiny)
console.log('vaultSize', vaultSize())

const pages: PageDocument[] = [0, 1, 14, 18].map((strandIndex) => ({
  strandIndex,
  title: `p${strandIndex + 1}`,
  text: `t${strandIndex}`,
  offsetMap: [],
}))

const ocrByStrand: Record<number, OcrPageResult> = {
  0: { blocks: [], confirmed: false } as OcrPageResult,
  14: { blocks: [], confirmed: false } as OcrPageResult,
  18: { blocks: [], confirmed: false } as OcrPageResult,
}

const { pack, imageStats } = await buildCorpusPack({
  label: 'test',
  docId: 'upload:test',
  bookIndex: { docId: 'upload:test', chunks: [] },
  ocrByStrand,
  semanticIndex: null,
  pages,
  includeImages: true,
  includeKeyLineage: false,
})

console.log('imageStats', imageStats)
console.log(
  'packed strands',
  pack.pages.filter((p) => p.imageDataUri).map((p) => p.strandIndex),
)
console.log('s14 vault', Boolean(peekPageImageDataUri(14)))

if (imageStats.imagesPacked !== 3) {
  throw new Error(`expected imagesPacked=3 got ${imageStats.imagesPacked}`)
}
if (
  !pack.pages
    .find((p) => p.strandIndex === 14)
    ?.imageDataUri?.startsWith('data:')
) {
  throw new Error('s14 should pack from vault')
}
console.log('VERIFY_OK')
