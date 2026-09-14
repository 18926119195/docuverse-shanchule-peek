/**
 * Composer：先判有无 LLM I/O 引入（§7.5）→ 第一步自动流 / 非第一步按 I/O 调度。
 */

import { useMemo, useState } from 'react'
import { useIndexGate } from '../reasoning/indexGate'
import { runComposerTurn } from '../reasoning/intentDeskRouter'
import { focusA1KeyOnPdf } from '../reasoning/focusA1Key'
import { shortHandle } from '../reasoning/ocrSlot'
import { useDocuverse } from '../canvas/store'
import { useAttentionIo } from '../reasoning/attentionIoStore'
import { usePanelSummonStore } from '../reasoning/panelSummonStore'
import { useLlmIoStream } from '../reasoning/llmIoStreamStore'
import { QueryPathCurtain } from './QueryPathCurtain'

export function A1ChatDock({
  compact = false,
}: {
  /** 结算下栏：收起台状态条，只留对话 + 幕布 */
  compact?: boolean
}) {
  const bookIndex = useIndexGate((s) => s.bookIndex)
  const indexReady = useIndexGate((s) => s.ready)
  const swoopToPage = useDocuverse((s) => s.swoopToPage)

  const deskPackages = useAttentionIo((s) => s.deskPackages)
  const pinnedAttention = useAttentionIo((s) => s.pinnedAttention)
  const lastStatus = useAttentionIo((s) => s.lastStatus)
  const deskPrompt = useAttentionIo((s) => s.deskPrompt)
  const intentSessionEpoch = useAttentionIo((s) => s.intentSessionEpoch)
  const intentDeskLog = useAttentionIo((s) => s.intentDeskLog)
  const clearDesk = useAttentionIo((s) => s.clearDesk)
  const clearDeskPrompt = useAttentionIo((s) => s.clearDeskPrompt)
  const unpinAttention = useAttentionIo((s) => s.unpinAttention)
  const focusPinnedAttention = useAttentionIo((s) => s.focusPinnedAttention)

  const pickup = useMemo(
    () => useAttentionIo.getState().getLetterDeskPickup(),
    [deskPackages],
  )

  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [ephemeralAnswer, setEphemeralAnswer] = useState<string | null>(null)

  const pinLabel = !pinnedAttention
    ? null
    : pinnedAttention.kind === 'edge'
      ? pinnedAttention.label
      : pinnedAttention.kind === 'infer'
        ? pinnedAttention.inferKey
        : pinnedAttention.queryKey
  const ioPinned = Boolean(deskPackages.length || pinnedAttention)
  const canSend =
    indexReady && !busy && (ioPinned || Boolean(draft.trim()))

  const send = async () => {
    if (!canSend) return
    const q = draft.trim()
    if (!ioPinned && !q) return
    if (!bookIndex || !indexReady) {
      useAttentionIo.getState().setLastStatus('请先上传 PDF 并等到建库就绪')
      return
    }
    setDraft('')
    setEphemeralAnswer(null)
    setBusy(true)

    try {
      // 一进对话立刻铸/复用 queryKey，幕布马上显示本问
      if (q) {
        const qk = useAttentionIo.getState().ensureQueryKey(q)
        useAttentionIo.getState().openQueryKey(qk)
        useAttentionIo
          .getState()
          .setDeskPrompt(`本问 · ${qk} · ${q.slice(0, 48)}${q.length > 48 ? '…' : ''}`)
      }

      // Step2 临时入口：调取/显示 + key 列表 → 常显面板（不经点开窗）
      const summonMatch = q.match(/^(调取|显示)\s+(.+)$/i)
      if (summonMatch) {
        const keys = summonMatch[2]!
          .split(/[\s,，;；]+/)
          .map((s) => s.trim())
          .filter(Boolean)
        usePanelSummonStore.getState().summonKeys(keys)
        useAttentionIo
          .getState()
          .setLastStatus(`已调取面板 ×${keys.length}（常显）`)
        setEphemeralAnswer(
          `常显面板：${keys.map((k) => `\`${k}\``).join(' · ')}`,
        )
        return
      }

      const hadDesk =
        useAttentionIo.getState().deskPackages.length > 0
      useAttentionIo.getState().setLastStatus('意图路由 / 自动流…')
      const result = await runComposerTurn({
        question: q,
        bookIndex,
        onProgress: (m) => {
          useAttentionIo.getState().setLastStatus(m)
          useLlmIoStream.getState().pushNote({
            job: 'auto_flow',
            stage: 'progress',
            text: m,
          })
        },
        sealItems: (items) => {
          const sealAttentionBond = useDocuverse.getState().sealAttentionBond
          return items.map((it) => {
            const chunk = bookIndex.chunks.find((c) => c.key === it.key)
            const bbox = chunk
              ? ([...chunk.bbox] as [number, number, number, number])
              : ([0, 0, 100, 100] as [number, number, number, number])
            const bondId = sealAttentionBond({
              strandIndex: chunk?.page ?? 0,
              bbox,
              confirmedText: it.bookText || it.key,
              comment: it.brief,
              bookKey: it.key,
              briefKey: it.briefKey,
            })
            return { ...it, bondId }
          })
        },
      })
      setEphemeralAnswer(result.answer || null)
      if (result.ok && q) {
        const keys = useAttentionIo.getState().listBookKeysForQuestion(q)
        if (keys[0]) {
          focusA1KeyOnPdf({
            key: keys[0],
            bookIndex,
            swoopToPage,
            alsoKeys: keys,
          })
        }
        // 自动流后常显本问相关门面（书门 + 最近 infer/query）
        const st = useAttentionIo.getState()
        const qk = st.ensureQueryKey(q)
        const toShow = [...keys]
        if (qk) toShow.push(qk)
        for (const e of st.inferEdges.filter((x) => x.queryKey === qk)) {
          toShow.push(e.inferKey)
        }
        for (const bk of st.queryKeyToBriefKeys[qk] ?? []) {
          toShow.push(bk)
        }
        if (toShow.length) usePanelSummonStore.getState().summonKeys(toShow)
      }
      useAttentionIo
        .getState()
        .setLastStatus(result.note || (result.ok ? '完成' : '失败'))
      if (
        hadDesk &&
        result.ok &&
        !result.note.startsWith('ask_user')
      ) {
        clearDesk()
      }
    } catch (e) {
      useAttentionIo
        .getState()
        .setLastStatus(e instanceof Error ? e.message : '失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className={
        compact
          ? 'a1-chat-dock a1-desk-dock a1-chat-dock--compact'
          : 'a1-chat-dock a1-desk-dock'
      }
      aria-label="自动流 / 旁路投递"
    >
      {!compact ? (
      <div className="a1-desk-wm" aria-label="写信台状态">
        <div className="a1-desk-wm-head">
          <span>
            {deskPackages.length > 0
              ? `已引入 I/O · 台包 ${pickup.packages.length}（投递按包 job）`
              : ioPinned
                ? '已钉住 LLM I/O · 发送按意图调度（非第一步）'
                : '纯问 · 冷启 bookKey 直入 decide（无 peek/brief）→ 有历史 queryKey 则 reuse，否则新铸'}
          </span>
          {deskPackages.length > 0 && (
            <button
              type="button"
              className="corpus-chip"
              onClick={() => clearDesk()}
            >
              清空台
            </button>
          )}
        </div>
        {pinnedAttention && deskPackages.length === 0 && (
          <ul className="a1-desk-wm-list" aria-label="已钉住的注意力窗">
            <li className="a1-desk-pin-row">
              <button
                type="button"
                className="a1-desk-wm-chip pin"
                title="点击跳转到该注意力窗"
                onClick={() => {
                  focusPinnedAttention()
                  useDocuverse.getState().setCommentLayerExpanded(true)
                }}
              >
                <span className="a1-desk-job">钉住</span>
                <code>{shortHandle(pinLabel || '')}</code>
              </button>
              <button
                type="button"
                className="corpus-chip"
                title="撤销钉住"
                onClick={() => unpinAttention()}
              >
                撤销钉住
              </button>
            </li>
          </ul>
        )}
        {deskPackages.length > 0 ? (
          <ul className="a1-desk-wm-list">
            {pickup.packages.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="a1-desk-wm-chip"
                  title={`${p.job} · ${p.question}`}
                  onClick={() => {
                    if (!bookIndex) return
                    focusA1KeyOnPdf({
                      key: p.bookKey,
                      bookIndex,
                      swoopToPage,
                    })
                    useAttentionIo.getState().openEdge(p.edgeId)
                    useDocuverse.getState().setCommentLayerExpanded(true)
                  }}
                >
                  <span className="a1-desk-job">{p.job}</span>
                  <code>{shortHandle(p.bookKey)}</code>
                  <span aria-hidden>·</span>
                  <code className="delta">{p.question.slice(0, 24)}</code>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="a1-desk-wm-hint">
            注意力窗 = LLM 的 I/O（打开≠钉住）。隐身旁点「切换注意力」才钉住。无钉窗=第一步；钉住后发送=按
            I/O 组合调度。意图会话 epoch={intentSessionEpoch}
            {intentDeskLog.length > 0
              ? ` · 台侧意图记 ${intentDeskLog.length}`
              : ''}
          </p>
        )}
      </div>
      ) : null}

      {deskPrompt && (
        <div className="a1-desk-prompt" role="alert">
          <header>
            <span>写信台提示</span>
            <button
              type="button"
              className="corpus-chip"
              onClick={() => clearDeskPrompt()}
            >
              知道了
            </button>
          </header>
          <p>{deskPrompt}</p>
        </div>
      )}

      {ephemeralAnswer && !compact && (
        <div className="a1-desk-ephemeral" role="status">
          <header>
            <span>
              {ephemeralAnswer?.startsWith('# 路径落账')
                ? '路径落账 · 有向增量回文（调度台）'
                : '本轮回文 · 未入 history'}
            </span>
            <button
              type="button"
              className="corpus-chip"
              onClick={() => setEphemeralAnswer(null)}
            >
              关掉
            </button>
          </header>
          <pre>{ephemeralAnswer}</pre>
        </div>
      )}

      {(busy || lastStatus) && !compact && (
        <p className="a1-chat-status">{busy ? lastStatus || '…' : lastStatus}</p>
      )}
      {compact && busy ? (
        <p className="a1-chat-status a1-chat-status--brief">
          {(lastStatus || '…').slice(0, 80)}
        </p>
      ) : null}

      {/* 结算紧凑：幕布在上、输入在下（避免 composer margin-top:auto 把幕布挤没） */}
      {compact ? <QueryPathCurtain /> : null}

      <form
        className="a1-chat-composer"
        onSubmit={(e) => {
          e.preventDefault()
          void send()
        }}
      >
        <input
          className="a1-chat-input"
          value={draft}
          disabled={busy}
          placeholder={
            !indexReady
              ? '等待建库…'
              : ioPinned
                ? '说明对钉住 I/O 的意图（重跑/推进/换方向）…'
                : '问文献…（第一步自动流）'
          }
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="a1-chat-send" disabled={!canSend}>
          {busy ? '…' : ioPinned ? '调度' : '自动流'}
        </button>
      </form>

      {/* 非紧凑：幕布仍在输入框下方 */}
      {!compact ? <QueryPathCurtain /> : null}
    </div>
  )
}
