export function withCors(res: Response, req: Request): Response {
  const origin = req.headers.get('origin') ?? '*'
  const headers = new Headers(res.headers)
  headers.set('Access-Control-Allow-Origin', origin)
  headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  headers.set(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, x-demo-token',
  )
  headers.set('Vary', 'Origin')
  return new Response(res.body, { status: res.status, headers })
}

export function preflight(req: Request): Response {
  return withCors(new Response(null, { status: 204 }), req)
}
