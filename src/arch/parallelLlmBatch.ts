/**
 * 大窗 LLM：key 去重分批 + 有限并发 + Abort 早停。
 * 「暂停」= 客户端 abort 未完成的 fetch；不能保证服务端已生成段不计费。
 */

export function dedupePreserveOrder(keys: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of keys) {
    const k = raw.trim()
    if (!k || seen.has(k)) continue
    seen.add(k)
    out.push(k)
  }
  return out
}

export function chunkKeys<T>(items: T[], size: number): T[][] {
  if (size <= 0) return [items]
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size))
  }
  return out
}

export function chunkUniqueKeys(keys: string[], size: number): string[][] {
  return chunkKeys(dedupePreserveOrder(keys), size)
}

export function linkAbortSignal(
  parent?: AbortSignal,
): { controller: AbortController; signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  const onParent = () => {
    try {
      controller.abort(parent?.reason ?? new DOMException('aborted', 'AbortError'))
    } catch {
      controller.abort()
    }
  }
  if (parent) {
    if (parent.aborted) onParent()
    else parent.addEventListener('abort', onParent, { once: true })
  }
  return {
    controller,
    signal: controller.signal,
    dispose: () => {
      if (parent) parent.removeEventListener('abort', onParent)
    },
  }
}

export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false
  const name = String((e as { name?: string }).name ?? '')
  if (name === 'AbortError') return true
  const msg = e instanceof Error ? e.message : String(e)
  return /abort|aborted|The user aborted/i.test(msg)
}

/**
 * 队列批并行：concurrency 路同时跑；shouldStop 为真则 abort 未启动/未完成的。
 */
export async function runBatchesParallel<TBatch, TResult>(input: {
  batches: TBatch[]
  concurrency: number
  signal?: AbortSignal
  run: (batch: TBatch, index: number, signal: AbortSignal) => Promise<TResult>
  /** 任一完成结果满足则取消其余 */
  shouldStop?: (result: TResult, index: number) => boolean
}): Promise<{
  results: Array<{ index: number; ok: true; value: TResult } | { index: number; ok: false; aborted: boolean; note: string }>
  stoppedEarly: boolean
  note: string
}> {
  const n = input.batches.length
  if (n === 0) {
    return { results: [], stoppedEarly: false, note: '并行批 · 空' }
  }
  const linked = linkAbortSignal(input.signal)
  const { controller, signal, dispose } = linked
  const concurrency = Math.max(1, Math.min(input.concurrency, n))
  const results: Array<
    | { index: number; ok: true; value: TResult }
    | { index: number; ok: false; aborted: boolean; note: string }
  > = new Array(n)
  let next = 0
  let stoppedEarly = false
  let inFlight = 0

  await new Promise<void>((resolve) => {
    const kick = () => {
      if (signal.aborted && inFlight === 0) {
        while (next < n) {
          results[next] = {
            index: next,
            ok: false,
            aborted: true,
            note: '并行早停 · 未启动',
          }
          next++
        }
        resolve()
        return
      }
      while (inFlight < concurrency && next < n && !signal.aborted) {
        const index = next++
        inFlight++
        const batch = input.batches[index]!
        void input
          .run(batch, index, signal)
          .then((value) => {
            results[index] = { index, ok: true, value }
            if (!stoppedEarly && input.shouldStop?.(value, index)) {
              stoppedEarly = true
              try {
                controller.abort(new DOMException('desk-early-stop', 'AbortError'))
              } catch {
                controller.abort()
              }
            }
          })
          .catch((e) => {
            const aborted = signal.aborted || isAbortError(e)
            results[index] = {
              index,
              ok: false,
              aborted,
              note: aborted
                ? '并行早停 · 已取消'
                : e instanceof Error
                  ? e.message
                  : '并行批失败',
            }
          })
          .finally(() => {
            inFlight--
            if (next >= n && inFlight === 0) resolve()
            else kick()
          })
      }
      if (signal.aborted && inFlight === 0) {
        while (next < n) {
          results[next] = {
            index: next,
            ok: false,
            aborted: true,
            note: '并行早停 · 未启动',
          }
          next++
        }
        resolve()
      }
    }
    kick()
  })

  dispose()
  const done = results.filter((r) => r?.ok).length
  const aborted = results.filter((r) => r && !r.ok && r.aborted).length
  return {
    results,
    stoppedEarly,
    note: `并行批 · 完成×${done}/${n}` + (stoppedEarly ? ` · 早停取消×${aborted}` : ''),
  }
}
