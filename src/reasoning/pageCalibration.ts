/**
 * Printed-page ↔ strandIndex calibration.
 *
 * N=1（默认）：strand = printed + offset，offset = anchorStrand - anchorPrinted
 * N=2（双页展开）：一机牌含连续两印码；
 *   strand = floor((printed - anchorPrinted) / N) + anchorStrand
 *   其中 anchorPrinted = 校准机牌上较小印码（对起点）
 */

export interface PageCalibration {
  /** Strand the user clicked when calibrating */
  anchorStrand: number
  /**
   * 校准机牌上的印码对起点（较小印码）。
   * N=1 时即该页唯一印码。
   */
  anchorPrinted: number
  /**
   * 校准机牌上的较大印码（仅 N>1 有意义）。
   */
  anchorPrintedHi?: number
  /**
   * 连续几个印码页共享一张机器牌。默认 1；双页展开 PDF 为 2。
   */
  printedPerStrand: number
  /**
   * N=1 时：strand = printed + offset。
   * N>1 时仅作旧包兼容字段（= anchorStrand - anchorPrinted），勿直接当映射。
   */
  offset: number
  calibratedAt: number
}

export function printedPerStrandOf(cal: PageCalibration): number {
  const n = Math.floor(cal.printedPerStrand ?? 1)
  return Number.isFinite(n) && n >= 1 ? Math.min(8, n) : 1
}

/** 旧语料包 / 缺字段 → 补齐 printedPerStrand */
export function normalizeCalibration(
  raw: Omit<PageCalibration, 'printedPerStrand'> & {
    printedPerStrand?: number
    anchorPrintedHi?: number
  },
): PageCalibration {
  const n = printedPerStrandOf({
    ...raw,
    printedPerStrand: raw.printedPerStrand ?? 1,
  } as PageCalibration)
  const lo = Math.floor(raw.anchorPrinted)
  const hiRaw = raw.anchorPrintedHi
  const hi =
    typeof hiRaw === 'number' && Number.isFinite(hiRaw)
      ? Math.floor(hiRaw)
      : n > 1
        ? lo + n - 1
        : lo
  return {
    anchorStrand: Math.floor(raw.anchorStrand),
    anchorPrinted: Math.min(lo, hi),
    anchorPrintedHi: n > 1 ? Math.max(lo, hi) : undefined,
    printedPerStrand: n,
    offset:
      typeof raw.offset === 'number' && Number.isFinite(raw.offset)
        ? raw.offset
        : Math.floor(raw.anchorStrand) - Math.min(lo, hi),
    calibratedAt:
      typeof raw.calibratedAt === 'number' ? raw.calibratedAt : Date.now(),
  }
}

export function makeCalibration(
  anchorStrand: number,
  anchorPrinted: number,
  opts?: {
    printedPerStrand?: number
    /** 同机牌另一印码（双页）；缺省且 N>1 时按 +(N-1) */
    anchorPrintedOther?: number
  },
): PageCalibration {
  const n = Math.max(1, Math.min(8, Math.floor(opts?.printedPerStrand ?? 1)))
  let lo = Math.floor(anchorPrinted)
  let hi =
    opts?.anchorPrintedOther != null &&
    Number.isFinite(opts.anchorPrintedOther)
      ? Math.floor(opts.anchorPrintedOther)
      : n > 1
        ? lo + n - 1
        : lo
  if (hi < lo) {
    const t = lo
    lo = hi
    hi = t
  }
  return normalizeCalibration({
    anchorStrand: Math.floor(anchorStrand),
    anchorPrinted: lo,
    anchorPrintedHi: n > 1 ? hi : undefined,
    printedPerStrand: n,
    offset: Math.floor(anchorStrand) - lo,
    calibratedAt: Date.now(),
  })
}

/** 印码 → 机器牌 strand（N>1 时同机牌多印码映到同一 strand） */
export function printedToStrand(
  printedPage: number,
  cal: PageCalibration,
): number {
  const n = printedPerStrandOf(cal)
  const p = Math.floor(printedPage)
  return Math.floor((p - cal.anchorPrinted) / n) + cal.anchorStrand
}

/** 机牌 → 该牌印码下界（N=1 即唯一印码） */
export function strandToPrinted(
  strandIndex: number,
  cal: PageCalibration,
): number {
  return printedLoOnStrand(strandIndex, cal)
}

export function printedLoOnStrand(
  strandIndex: number,
  cal: PageCalibration,
): number {
  const n = printedPerStrandOf(cal)
  return cal.anchorPrinted + (strandIndex - cal.anchorStrand) * n
}

export function printedHiOnStrand(
  strandIndex: number,
  cal: PageCalibration,
): number {
  return printedLoOnStrand(strandIndex, cal) + printedPerStrandOf(cal) - 1
}

/** 末机牌上最大印码（填末节印码界用） */
export function maxPrintedForStrand(
  maxStrand: number,
  cal: PageCalibration,
): number {
  return printedHiOnStrand(maxStrand, cal)
}

export function printedRangeToStrandRange(
  startPrinted: number,
  endPrinted: number,
  cal: PageCalibration,
): { startPage: number; endPage: number } {
  const a = printedToStrand(startPrinted, cal)
  const b = printedToStrand(endPrinted, cal)
  return {
    startPage: Math.min(a, b),
    endPage: Math.max(a, b),
  }
}

export function calibrationNote(cal: PageCalibration): string {
  const n = printedPerStrandOf(cal)
  const machine = `机器第 ${cal.anchorStrand + 1} 张牌（strand ${cal.anchorStrand}）`
  if (n <= 1) {
    return `书上第 ${cal.anchorPrinted} 页 = ${machine} · 1印码/牌 · offset=${cal.offset}`
  }
  const hi = cal.anchorPrintedHi ?? cal.anchorPrinted + n - 1
  return (
    `书上第 ${cal.anchorPrinted}–${hi} 页 = ${machine} · ${n}印码/牌` +
    ` · strand=⌊(印码−${cal.anchorPrinted})/${n}⌋+${cal.anchorStrand}`
  )
}
