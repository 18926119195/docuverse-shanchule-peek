/**
 * POST /api/llm/embeddings — disabled (product uses A1 + chat only).
 */
export const config = { runtime: 'edge', maxDuration: 10 }

export default async function handler(): Promise<Response> {
  return new Response(
    JSON.stringify({
      error: 'embedding_disabled',
      message: '本项目已关闭 embedding；检索走 A1 + DeepSeek chat。',
    }),
    { status: 410, headers: { 'Content-Type': 'application/json' } },
  )
}
