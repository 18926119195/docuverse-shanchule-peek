/**
 * Permanent bonds: PDF original slice ↔ user-confirmed OCR text ↔ comment.
 * User beams: intentional rays between two bonds (never auto-generated).
 */

import type { FlinkType } from '../zigzag/types'

/** 0–1000 bbox on the original PDF page image */
export type PageBbox = [number, number, number, number]

/**
 * Permanent triple binding — survives OCR re-runs only if user keeps it;
 * OCR re-recognize does not auto-mutate existing bonds.
 */
export interface PermanentBond {
  id: string
  strandIndex: number
  /** Region on the original PDF page */
  bbox: PageBbox
  /** OCR block this bond was sealed from (may later be deleted; text is snapshotted) */
  ocrBlockId: string
  /** User-verified OCR text at confirm time (= 注意力窗左侧 / book T) */
  confirmedText: string
  /** User annotation permanently attached (= 注意力窗右侧 / brief · 评论层正文) */
  comment: string
  /** Peek / 注意力身份：layout 划重点铸的 bookKey（与强调笔共 bbox 基底） */
  bookKey?: string
  /** Peek / 注意力增量 key（Δ） */
  briefKey?: string
  createdAt: number
  updatedAt: number
}

/** User-drawn ray between two permanent bonds */
export interface UserBeam {
  id: string
  fromBondId: string
  toBondId: string
  flinkType: FlinkType
  createdAt: number
}

export function newBondId(): string {
  return `bond_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

export function newBeamId(): string {
  return `beam_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`
}

const STORAGE_PREFIX = 'docuverse.bonds.v1:'

export function bondsStorageKey(corpus: string, label: string | null): string {
  return `${STORAGE_PREFIX}${corpus}:${label ?? 'default'}`
}

export function loadBondState(key: string): {
  bonds: PermanentBond[]
  beams: UserBeam[]
} {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return { bonds: [], beams: [] }
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return { bonds: [], beams: [] }
    const rec = parsed as Record<string, unknown>
    const bonds = Array.isArray(rec.bonds) ? (rec.bonds as PermanentBond[]) : []
    const beams = Array.isArray(rec.beams) ? (rec.beams as UserBeam[]) : []
    return { bonds, beams }
  } catch {
    return { bonds: [], beams: [] }
  }
}

export function saveBondState(
  key: string,
  bonds: PermanentBond[],
  beams: UserBeam[],
): void {
  try {
    localStorage.setItem(key, JSON.stringify({ bonds, beams }))
  } catch {
    /* quota / private mode */
  }
}

/** Remove all persisted bond / beam corpora. */
export function clearAllBondStorage(): number {
  let n = 0
  try {
    const keys: string[] = []
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(STORAGE_PREFIX)) keys.push(k)
    }
    for (const k of keys) {
      localStorage.removeItem(k)
      n++
    }
  } catch {
    /* private mode */
  }
  return n
}
