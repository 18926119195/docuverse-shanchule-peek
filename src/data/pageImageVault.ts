/**
 * 语料包页图金库：瘦载入时只存 data URI，审计 bookKey 时再解码成 blob URL。
 * 与书序无关；按 strand 调取。
 */

const vault = new Map<number, string>()

export function clearPageImageVault(): void {
  vault.clear()
}

export function stashPageImageDataUri(
  strand: number,
  dataUri: string | undefined,
): void {
  if (strand < 0) return
  if (!dataUri || !dataUri.startsWith('data:')) {
    vault.delete(strand)
    return
  }
  vault.set(strand, dataUri)
}

export function stashPageImagesFromPack(
  pages: Array<{ strandIndex: number; imageDataUri?: string }>,
): number {
  let n = 0
  for (const p of pages) {
    if (p.imageDataUri?.startsWith('data:')) {
      vault.set(p.strandIndex, p.imageDataUri)
      n += 1
    }
  }
  return n
}

export function peekPageImageDataUri(strand: number): string | undefined {
  return vault.get(strand)
}

export function hasPageImageInVault(strand: number): boolean {
  return vault.has(strand)
}

export function vaultSize(): number {
  return vault.size
}

/** data URI → blob: URL（调用方负责 revoke 旧链） */
export function dataUriToObjectUrl(dataUri: string): string {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(dataUri)
  if (!m) throw new Error('无效 imageDataUri')
  const mime = m[1] || 'image/jpeg'
  const isB64 = Boolean(m[2])
  const data = m[3] || ''
  let bytes: Uint8Array
  if (isB64) {
    const bin = atob(data)
    bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(data))
  }
  const ab = bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer
  return URL.createObjectURL(
    new Blob([ab], {
      type: mime,
    }),
  )
}

/**
 * 从金库物化一页图。成功则仍保留 data URI（可再物化）；不删除金库。
 */
export function materializePageImageFromVault(strand: number): {
  ok: true
  imageUrl: string
} | { ok: false; note: string } {
  const dataUri = vault.get(strand)
  if (!dataUri) {
    return { ok: false, note: `金库无 strand=${strand} 页图` }
  }
  try {
    return { ok: true, imageUrl: dataUriToObjectUrl(dataUri) }
  } catch (e) {
    return {
      ok: false,
      note: e instanceof Error ? e.message : '页图解码失败',
    }
  }
}
