/**
 * pdf.js worker dynamically imports `/pdfjs-wasm/*` fallbacks.
 * Vite 8 rejects those paths when they live under /public (static-only).
 * Resolve + serve from pdfjs-dist/wasm instead.
 */
import fs from 'node:fs'
import path from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, PreviewServer, ViteDevServer } from 'vite'

const WASM_PREFIX = '/pdfjs-wasm/'

function wasmRoot(root: string): string {
  return path.resolve(root, 'node_modules/pdfjs-dist/wasm')
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8'
  if (filePath.endsWith('.wasm')) return 'application/wasm'
  return 'application/octet-stream'
}

function serveWasmFile(
  dir: string,
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  const raw = (req.url ?? '').split('?')[0] ?? ''
  const rel = decodeURIComponent(raw.replace(/^\//, ''))
  if (!rel || rel.includes('..')) {
    next()
    return
  }
  const filePath = path.resolve(dir, rel)
  if (!filePath.startsWith(dir + path.sep) && filePath !== dir) {
    res.statusCode = 403
    res.end('Forbidden')
    return
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      next()
      return
    }
    res.setHeader('Content-Type', contentType(filePath))
    res.end(data)
  })
}

function mountWasmStatic(
  server: ViteDevServer | PreviewServer,
  root: string,
): void {
  const dir = wasmRoot(root)
  server.middlewares.use(WASM_PREFIX, (req, res, next) => {
    serveWasmFile(dir, req, res, next)
  })
}

function copyWasmToDist(root: string): void {
  const src = wasmRoot(root)
  const dest = path.resolve(root, 'dist/pdfjs-wasm')
  fs.mkdirSync(dest, { recursive: true })
  for (const name of fs.readdirSync(src)) {
    if (name.startsWith('LICENSE')) continue
    fs.copyFileSync(path.join(src, name), path.join(dest, name))
  }
}

export function pdfJsWasmPlugin(root: string): Plugin {
  const absRoot = path.resolve(root)
  return {
    name: 'docuverse-pdfjs-wasm',
    resolveId(id) {
      if (!id.startsWith(WASM_PREFIX)) return null
      const rel = id.slice(WASM_PREFIX.length)
      if (!rel || rel.includes('..')) return null
      return path.join(wasmRoot(absRoot), rel)
    },
    configureServer(server) {
      mountWasmStatic(server, absRoot)
    },
    configurePreviewServer(server) {
      mountWasmStatic(server, absRoot)
    },
    closeBundle() {
      copyWasmToDist(absRoot)
    },
  }
}
