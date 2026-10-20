// The training service status the main app's moderators set (`training.setStatus`, stored in the sys
// redis `training:status` hash field). Studio reads only the two fields users see; `blockedModels` stays
// a server-side refusal.
export type TrainingServiceStatus = { available: boolean; message: string | null };

/** Normalise a raw status (the stored JSON, or the main app's `training.getStatus` response). Anything
 *  unreadable reads as the schema default — available, no message — the same fail-open the main app's
 *  `getTrainingServiceStatus` applies, so a bad value never blocks training. */
export function parseServiceStatus(raw: unknown): TrainingServiceStatus {
  if (!raw || typeof raw !== 'object') return { available: true, message: null };
  const { available, message } = raw as { available?: unknown; message?: unknown };
  return {
    available: typeof available === 'boolean' ? available : true,
    message: typeof message === 'string' && message.trim() ? message.trim() : null,
  };
}

export type MessageSegment =
  | { kind: 'text'; text: string }
  | { kind: 'strong'; text: string }
  | { kind: 'link'; text: string; href: string };

const INLINE = /\*\*([^*]+)\*\*|\[([^\]]+)\]\(([^)\s]+)\)/g;

/** Split a status message into the markdown the classic trainer renders (`**strong**` and
 *  `[links](url)` — its CustomMarkdown allows only `a` and `strong`), so the banner can render it
 *  without `{@html}`. A link to anything but http(s) stays plain text. */
export function messageSegments(message: string): MessageSegment[] {
  const segments: MessageSegment[] = [];
  let last = 0;
  for (const match of message.matchAll(INLINE)) {
    if (match.index > last) segments.push({ kind: 'text', text: message.slice(last, match.index) });
    const [whole, strong, linkText, href] = match;
    if (strong !== undefined) segments.push({ kind: 'strong', text: strong });
    else if (/^https?:\/\//i.test(href!))
      segments.push({ kind: 'link', text: linkText!, href: href! });
    else segments.push({ kind: 'text', text: whole });
    last = match.index + whole.length;
  }
  if (last < message.length) segments.push({ kind: 'text', text: message.slice(last) });
  return segments;
}
