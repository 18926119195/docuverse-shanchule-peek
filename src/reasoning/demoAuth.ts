/**
 * Browser → backend demo token (optional).
 * Set VITE_DEMO_ACCESS_TOKEN to match server DEMO_ACCESS_TOKEN.
 */
export function demoAuthHeaders(): Record<string, string> {
  const token = (
    typeof import.meta.env.VITE_DEMO_ACCESS_TOKEN === 'string'
      ? import.meta.env.VITE_DEMO_ACCESS_TOKEN
      : ''
  ).trim()
  if (!token) return {}
  return {
    Authorization: `Bearer ${token}`,
    'x-demo-token': token,
  }
}
