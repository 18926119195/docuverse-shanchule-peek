/**
 * Persist BookSemanticIndex beside A1.
 */

import type { BookSemanticIndex, SectionNode, SlotProvenance } from './semanticIndex'
import {
  normalizeCalibration,
  type PageCalibration,
} from './pageCalibration'

const STORAGE_PREFIX = 'docuverse.semantic.v1:'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

function parsePageRange(
  v: unknown,
): { startPage: number; endPage: number } | undefined {
  if (!isRecord(v)) return undefined
  if (typeof v.startPage !== 'number' || typeof v.endPage !== 'number') {
    return undefined
  }
  return { startPage: v.startPage, endPage: v.endPage }
}

function parseCalibration(v: unknown): PageCalibration | undefined {
  if (!isRecord(v)) return undefined
  if (
    typeof v.anchorStrand !== 'number' ||
    typeof v.anchorPrinted !== 'number' ||
    typeof v.offset !== 'number'
  ) {
    return undefined
  }
  return normalizeCalibration({
    anchorStrand: v.anchorStrand,
    anchorPrinted: v.anchorPrinted,
    offset: v.offset,
    printedPerStrand:
      typeof v.printedPerStrand === 'number' ? v.printedPerStrand : 1,
    anchorPrintedHi:
      typeof v.anchorPrintedHi === 'number' ? v.anchorPrintedHi : undefined,
    calibratedAt:
      typeof v.calibratedAt === 'number' ? v.calibratedAt : Date.now(),
  })
}

function parseSection(v: unknown): SectionNode | null {
  if (!isRecord(v)) return null
  if (
    typeof v.nodeId !== 'string' ||
    typeof v.docId !== 'string' ||
    typeof v.page !== 'number' ||
    typeof v.title !== 'string' ||
    typeof v.summary !== 'string' ||
    typeof v.ord !== 'number'
  ) {
    return null
  }
  const source = v.source
  if (
    source !== 'ocr_title' &&
    source !== 'page_header' &&
    source !== 'heuristic'
  ) {
    return null
  }
  return {
    nodeId: v.nodeId,
    docId: v.docId,
    page: v.page,
    pageRange: parsePageRange(v.pageRange),
    memberKeys: Array.isArray(v.memberKeys)
      ? v.memberKeys.filter((x): x is string => typeof x === 'string')
      : undefined,
    title: v.title,
    summary: v.summary,
    source,
    probe: Array.isArray(v.probe)
      ? v.probe.filter((x): x is number => typeof x === 'number')
      : undefined,
    parentId: typeof v.parentId === 'string' ? v.parentId : undefined,
    ord: v.ord,
  }
}

function parseProvenance(v: unknown): SlotProvenance | null {
  if (!isRecord(v)) return null
  if (typeof v.key !== 'string' || typeof v.primaryNodeId !== 'string') {
    return null
  }
  const role = v.role
  if (role !== 'body' && role !== 'title' && role !== 'caption' && role !== 'figure') {
    return null
  }
  return {
    key: v.key,
    primaryNodeId: v.primaryNodeId,
    secondaryNodeIds: Array.isArray(v.secondaryNodeIds)
      ? v.secondaryNodeIds.filter((x): x is string => typeof x === 'string')
      : undefined,
    role,
  }
}

export function saveSemanticIndex(index: BookSemanticIndex): void {
  try {
    localStorage.setItem(STORAGE_PREFIX + index.docId, JSON.stringify(index))
  } catch {
    /* quota */
  }
}

export function loadSemanticIndex(docId: string): BookSemanticIndex | null {
  try {
    const raw = localStorage.getItem(STORAGE_PREFIX + docId)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!isRecord(parsed) || typeof parsed.docId !== 'string') return null
    if (!Array.isArray(parsed.sections) || !Array.isArray(parsed.provenance)) {
      return null
    }
    const sections: SectionNode[] = []
    for (const item of parsed.sections) {
      const s = parseSection(item)
      if (s) sections.push(s)
    }
    const provenance: SlotProvenance[] = []
    for (const item of parsed.provenance) {
      const p = parseProvenance(item)
      if (p) provenance.push(p)
    }
    return {
      docId: parsed.docId,
      sections,
      provenance,
      builtAt: typeof parsed.builtAt === 'number' ? parsed.builtAt : Date.now(),
      tocConfirmed: parsed.tocConfirmed === true,
      tocSkipped: parsed.tocSkipped === true,
      pageCalibration: parseCalibration(parsed.pageCalibration),
    }
  } catch {
    return null
  }
}

export function clearSemanticIndex(docId: string): void {
  try {
    localStorage.removeItem(STORAGE_PREFIX + docId)
  } catch {
    /* ignore */
  }
}
