/**
 * Render-proxy LOD for page bitmaps — semantic layer unchanged.
 * One source URL → downscaled mip cache; swap by camera distance.
 */

import * as THREE from 'three'

export type PageTextureLodLevel = 0 | 1 | 2 | 3

/** Max width per level (height scales proportionally). */
export const PAGE_LOD_MAX_WIDTH: Record<PageTextureLodLevel, number> = {
  0: 128,
  1: 256,
  2: 512,
  3: 4096,
}

const LOD_LABEL = ['thumb', 'low', 'mid', 'full'] as const

type LodCache = Map<PageTextureLodLevel, THREE.Texture>
const cacheByUrl = new Map<string, LodCache>()
const inflight = new Map<string, Promise<THREE.Texture>>()

function cacheKey(url: string, level: PageTextureLodLevel): string {
  return `${url}@lod${level}`
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`页图加载失败: ${url}`))
    img.src = url
  })
}

function downscaleToCanvas(
  img: HTMLImageElement,
  maxWidth: number,
): HTMLCanvasElement {
  const w = img.naturalWidth || img.width
  const h = img.naturalHeight || img.height
  const scale = Math.min(1, maxWidth / Math.max(w, 1))
  const cw = Math.max(1, Math.round(w * scale))
  const ch = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法创建画布')
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(img, 0, 0, cw, ch)
  return canvas
}

function canvasToTexture(canvas: HTMLCanvasElement): THREE.Texture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.minFilter = THREE.LinearMipmapLinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = true
  tex.anisotropy = 4
  tex.needsUpdate = true
  return tex
}

/** Fetch or build a cached LOD texture for one page URL. */
export async function getPageTextureLod(
  url: string,
  level: PageTextureLodLevel,
): Promise<THREE.Texture> {
  let byLevel = cacheByUrl.get(url)
  if (!byLevel) {
    byLevel = new Map()
    cacheByUrl.set(url, byLevel)
  }
  const hit = byLevel.get(level)
  if (hit) return hit

  const inflightKey = cacheKey(url, level)
  const pending = inflight.get(inflightKey)
  if (pending) return pending

  const job = (async () => {
    const img = await loadImage(url)
    const maxW = PAGE_LOD_MAX_WIDTH[level]
    const canvas =
      level === 3 && img.naturalWidth <= maxW
        ? (() => {
            const c = document.createElement('canvas')
            c.width = img.naturalWidth
            c.height = img.naturalHeight
            c.getContext('2d')!.drawImage(img, 0, 0)
            return c
          })()
        : downscaleToCanvas(img, maxW)
    const tex = canvasToTexture(canvas)
    byLevel!.set(level, tex)
    inflight.delete(inflightKey)
    return tex
  })()

  inflight.set(inflightKey, job)
  return job
}

const _page = new THREE.Vector3()

/** World-space distance from camera to page centre. */
export function cameraDistanceToPage(
  camera: THREE.Camera,
  pageWorldMatrix: THREE.Matrix4,
): number {
  _page.setFromMatrixPosition(pageWorldMatrix)
  return camera.position.distanceTo(_page)
}

export interface PageLodPickInput {
  distance: number
  role: 'current' | 'companion' | 'background'
  emphasizeMode: boolean
  isAimOrStrokePage: boolean
  currentLevel: PageTextureLodLevel
}

/**
 * Distance bands for LOD (world units). Level 3 = full, 0 = thumb.
 * Exit thresholds add hysteresis when stepping down.
 */
const LOD_ENTER = [22, 38, 62, Infinity] as const
const LOD_EXIT = [28, 44, 68, Infinity] as const

function rawLevelForDistance(distance: number): PageTextureLodLevel {
  if (distance <= LOD_ENTER[0]) return 3
  if (distance <= LOD_ENTER[1]) return 2
  if (distance <= LOD_ENTER[2]) return 1
  return 0
}

/**
 * Pick LOD with hysteresis so textures don't thrash at boundaries.
 * current / companion / pen page stay sharper.
 */
export function pickPageTextureLod(input: PageLodPickInput): PageTextureLodLevel {
  const { distance, role, emphasizeMode, isAimOrStrokePage, currentLevel } =
    input

  let minLevel: PageTextureLodLevel = 0
  if (role === 'current' || role === 'companion') minLevel = 2
  if (emphasizeMode && isAimOrStrokePage) minLevel = 3

  let target = rawLevelForDistance(distance)
  target = Math.max(target, minLevel) as PageTextureLodLevel

  if (target < currentLevel) {
    const exit = LOD_EXIT[currentLevel]
    if (distance <= exit) {
      target = currentLevel
    } else {
      target = Math.max(
        minLevel,
        (currentLevel - 1) as PageTextureLodLevel,
      ) as PageTextureLodLevel
    }
  }

  return Math.min(3, Math.max(minLevel, target)) as PageTextureLodLevel
}

export function pageLodLabel(level: PageTextureLodLevel): string {
  return LOD_LABEL[level]
}

/** Dev HUD / debug — count cached textures. */
export function pageTextureLodCacheStats(): {
  urls: number
  textures: number
} {
  let textures = 0
  for (const m of cacheByUrl.values()) textures += m.size
  return { urls: cacheByUrl.size, textures }
}
