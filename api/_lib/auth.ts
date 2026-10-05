import { demoAccessToken } from './env.js'

export function unauthorized(message: string): Response {
  return Response.json({ error: message }, { status: 401 })
}

/**
 * Require DEMO_ACCESS_TOKEN when configured.
 * Client sends: Authorization: Bearer <token>  or  x-demo-token: <token>
 */
export function assertDemoAccess(req: Request): Response | null {
  const expected = demoAccessToken()
  if (!expected) return null

  const auth = req.headers.get('authorization')?.trim() ?? ''
  const headerToken = req.headers.get('x-demo-token')?.trim() ?? ''
  let bearer = ''
  if (auth.toLowerCase().startsWith('bearer ')) {
    bearer = auth.slice(7).trim()
  }
  const got = headerToken || bearer
  if (got !== expected) {
    return unauthorized('demo token required or invalid')
  }
  return null
}
