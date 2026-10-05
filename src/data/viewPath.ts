/** Outer-shell camera keyframe — one sample on the view-path “film”. */

export type ViewKeyframeTag = '放大' | '缩小' | '环视' | '打点'

export type ViewKeyframe = {
  id: string
  /** Monotonic order along the path (0, 1, 2, …); gaps ok after deletes */
  seq: number
  yaw: number
  pitch: number
  distance: number
  at: number
  /** How this frame was authored — orbit / manual mark (zoom is never recorded) */
  tag: ViewKeyframeTag
}

export type ViewPathMode = 'live' | 'playing' | 'paused'

export const VIEW_PATH_MAX = 400
const YAW_EPS = 0.012
const PITCH_EPS = 0.012
const DIST_EPS = 0.35

export function newViewKeyframeId(): string {
  return `vk-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
}

export function posesNearlyEqual(
  a: { yaw: number; pitch: number; distance: number },
  b: { yaw: number; pitch: number; distance: number },
): boolean {
  const dyaw = Math.abs(a.yaw - b.yaw)
  const wrap = Math.min(dyaw, Math.abs(dyaw - Math.PI * 2))
  return (
    wrap < YAW_EPS &&
    Math.abs(a.pitch - b.pitch) < PITCH_EPS &&
    Math.abs(a.distance - b.distance) < DIST_EPS
  )
}

/** Cursor in [0, n-1]; lerp between neighbouring keyframes. */
export function sampleViewPath(
  frames: ViewKeyframe[],
  cursor: number,
): { yaw: number; pitch: number; distance: number } | null {
  if (frames.length === 0) return null
  if (frames.length === 1) {
    const f = frames[0]
    return { yaw: f.yaw, pitch: f.pitch, distance: f.distance }
  }
  const max = frames.length - 1
  const c = Math.min(max, Math.max(0, cursor))
  const i0 = Math.floor(c)
  const i1 = Math.min(max, i0 + 1)
  const t = c - i0
  const a = frames[i0]
  const b = frames[i1]
  let dy = b.yaw - a.yaw
  if (dy > Math.PI) dy -= Math.PI * 2
  if (dy < -Math.PI) dy += Math.PI * 2
  return {
    yaw: a.yaw + dy * t,
    pitch: a.pitch + (b.pitch - a.pitch) * t,
    distance: a.distance + (b.distance - a.distance) * t,
  }
}

export function appendKeyframe(
  frames: ViewKeyframe[],
  pose: { yaw: number; pitch: number; distance: number },
  tag: ViewKeyframeTag,
  opts?: { force?: boolean },
): ViewKeyframe[] {
  const last = frames[frames.length - 1]
  if (!opts?.force && last && posesNearlyEqual(last, pose)) return frames
  const next: ViewKeyframe = {
    id: newViewKeyframeId(),
    seq: last ? last.seq + 1 : 0,
    yaw: pose.yaw,
    pitch: pose.pitch,
    distance: pose.distance,
    at: Date.now(),
    tag,
  }
  const merged = [...frames, next]
  if (merged.length <= VIEW_PATH_MAX) return merged
  return merged.slice(merged.length - VIEW_PATH_MAX)
}

export function viewKeyframeTagClass(tag: ViewKeyframeTag): string {
  switch (tag) {
    case '放大':
      return 'tag-zoom-in'
    case '缩小':
      return 'tag-zoom-out'
    case '环视':
      return 'tag-orbit'
    case '打点':
      return 'tag-mark'
  }
}
