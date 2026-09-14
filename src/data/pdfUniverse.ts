/**
 * Built-in patent demo corpus — disabled (empty).
 * Use PDF upload for real books; patents were mixing strand indices with uploads.
 */

import type { PageDocument, ResolvedConnection } from '../zigzag/types'

interface PdfSource {
  id: 'connections' | 'intercalation'
  label: string
  short: string
  pageCount: number
}

/** Kept for type/docs only — not loaded into the scene. */
const SOURCES: PdfSource[] = []

export function buildPdfPageUniverse(): {
  pages: PageDocument[]
  connections: ResolvedConnection[]
} {
  return { pages: [], connections: [] }
}

export const PDF_SOURCES = SOURCES
