/** Cut to at most `max` UTF-16 code units without splitting a surrogate pair. */
export function head(text: string, max: number): string {
  if (text.length <= max) return text;
  let end = Math.max(0, max);
  if (end > 0) {
    const last = text.charCodeAt(end - 1);
    if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  }
  return text.slice(0, end);
}

/** head(), plus a note saying how much was dropped. */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  const kept = head(text, max);
  return `${kept}\n… [${text.length - kept.length} more chars]`;
}
