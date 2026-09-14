/**
 * 外显演示：仅隐藏/脱敏易泄露数据结构的小字（key*、槽位公式等），不关闭交互功能。
 * 开发全量面板：VITE_PUBLIC_DEMO=false
 */
export const isPublicDemo =
  import.meta.env.VITE_PUBLIC_DEMO !== 'false'

/** @deprecated 别名 */
export const isInterviewDemo = isPublicDemo

export function demoPageRef(page: number): string {
  return `第 ${page + 1} 页`
}

export function demoIndexPhaseLabel(phase: string): string {
  switch (phase) {
    case 'importing':
      return '导入中'
    case 'ocr':
      return '识别中'
    case 'embedding':
      return '整理中'
    case 'ready':
      return '可对照'
    case 'error':
      return '未完成'
    default:
      return '等待文献'
  }
}

export function demoReadyLine(chunkCount: number): string {
  return `文献已就绪 · ${chunkCount} 段可检索`
}

/** 去掉 excerpt 里的槽位/分数/debug 行，仅保留可读正文（生产与演示默认开启） */
export function sanitizePublicExcerpt(raw: string, maxLen = 160): string {
  return raw
    .replace(/^【槽[\s\S]*?】\n?/m, '')
    .replace(/^【跨槽组合[\s\S]*?】\n?/m, '')
    .replace(/^读值范围[^\n]*\n?/m, '')
    .replace(/\bfused\s*=\s*[\d.]+/gi, '')
    .replace(/\bdense\s*=\s*[\d.]+/gi, '')
    .replace(/\bbm25\s*=\s*[\d.]+/gi, '')
    .replace(/h1\.[A-Za-z0-9_-]{12,}/g, '')
    .trim()
    .slice(0, maxLen)
}
