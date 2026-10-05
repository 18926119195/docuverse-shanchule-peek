/**
 * Opaque session handles: lockId never leaves the server in plaintext.
 * Handle = h1. + base64url(AES-GCM(lockId)) with deterministic IV
 * so the same doorplate always seals to the same handle (stable across cold starts).
 */
import { demoAccessToken, serverEnv } from '../env.js'

export const HANDLE_PREFIX = 'h1.'

function handleSecret(): string {
  return (
    serverEnv('HANDLE_SECRET') ||
    demoAccessToken() ||
    'docuverse-dev-handle-secret'
  )
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!)
  if (typeof btoa !== 'function') {
    throw new Error('btoa unavailable')
  }
  return btoa(bin)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
}

function base64UrlToBytes(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const pad = b64.length % 4 === 0 ? '' : '='.repeat(4 - (b64.length % 4))
  if (typeof atob !== 'function') {
    throw new Error('atob unavailable')
  }
  const raw = atob(b64 + pad)
  const out = new Uint8Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

async function aesKey(): Promise<CryptoKey> {
  const dig = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(handleSecret()),
  )
  return crypto.subtle.importKey('raw', dig, 'AES-GCM', false, [
    'encrypt',
    'decrypt',
  ])
}

/** Deterministic 12-byte IV from secret + lockId (stable seal). */
async function ivForLockId(lockId: string): Promise<Uint8Array<ArrayBuffer>> {
  const dig = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(`${handleSecret()}|iv|${lockId}`),
  )
  const iv = new Uint8Array(12)
  iv.set(new Uint8Array(dig).subarray(0, 12))
  return iv
}

export function isSealedHandle(value: string): boolean {
  return value.startsWith(HANDLE_PREFIX) && value.length > HANDLE_PREFIX.length + 8
}

/** Seal intrinsic lockId → opaque handle for the browser. */
export async function sealLockId(lockId: string): Promise<string> {
  const key = await aesKey()
  const iv = await ivForLockId(lockId)
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(lockId),
  )
  const packed = new Uint8Array(iv.length + ct.byteLength)
  packed.set(iv, 0)
  packed.set(new Uint8Array(ct), iv.length)
  return HANDLE_PREFIX + bytesToBase64Url(packed)
}

/** Unseal browser handle → lockId (server only). */
export async function unsealHandle(handle: string): Promise<string> {
  if (!isSealedHandle(handle)) {
    throw new Error('invalid sealed handle')
  }
  const packed = base64UrlToBytes(handle.slice(HANDLE_PREFIX.length))
  if (packed.length < 28) throw new Error('handle too short')
  const iv = packed.slice(0, 12)
  const ct = packed.slice(12)
  const key = await aesKey()
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct)
  return new TextDecoder().decode(pt)
}

export async function sealMany(lockIds: string[]): Promise<string[]> {
  return Promise.all(lockIds.map((id) => sealLockId(id)))
}

export async function unsealMany(handles: string[]): Promise<string[]> {
  return Promise.all(handles.map((h) => unsealHandle(h)))
}
