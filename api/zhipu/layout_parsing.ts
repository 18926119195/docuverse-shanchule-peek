/**
 * POST /api/zhipu/layout_parsing → 智谱 OCR
 */
import { zhipuApiKey } from '../_lib/env.js'
import { proxyUpstream } from '../_lib/upstreamProxy.js'

export const config = { runtime: 'edge', maxDuration: 60 }

const ZHIPU_ROOT = 'https://open.bigmodel.cn/api/paas/v4'

export default async function handler(req: Request): Promise<Response> {
  return proxyUpstream(req, {
    stripPrefix: '/api/zhipu',
    baseUrl: ZHIPU_ROOT,
    apiKey: zhipuApiKey(),
    missingKeyMessage:
      'ZHIPU_API_KEY missing on server (set in Vercel Environment Variables)',
  })
}
