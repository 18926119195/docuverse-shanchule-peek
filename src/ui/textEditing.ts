/** True when the user is typing into a form field or contenteditable — skip hotkeys. */
export function isTextEditingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true
  // nested editable (e.g. comment Html panel)
  return Boolean(target.closest('input, textarea, select, [contenteditable="true"]'))
}
