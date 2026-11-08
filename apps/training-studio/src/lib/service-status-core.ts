import { versionsForRun } from '$lib/data/trainingModels';

// The training service status the main app's moderators set (`training.setStatus`, stored in the sys
// redis `training:status` hash field). `blockedModels` holds the main app's `trainingDetails.baseModel`
// keys (`ModelVersionInfo.key` here) that are down: their cards show as unavailable and a submit is refused.
export type TrainingServiceStatus = {
  available: boolean;
  message: string | null;
  blockedModels: string[];
  /** Optional per-key note shown under "Temporarily unavailable". */
  blockedModelReasons: Record<string, string>;
};

export const UNAVAILABLE_LABEL = 'Temporarily unavailable';

const trimmed = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** Normalise a raw status (the stored JSON, or the main app's `training.getStatus` response). Anything
 *  unreadable reads as the schema default — available, no message, nothing blocked — the same fail-open
 *  the main app's `getTrainingServiceStatus` applies, so a bad value never blocks training. */
export function parseServiceStatus(raw: unknown): TrainingServiceStatus {
  if (!raw || typeof raw !== 'object')
    return { available: true, message: null, blockedModels: [], blockedModelReasons: {} };
  const { available, message, blockedModels, blockedModelReasons } = raw as Record<string, unknown>;
  const reasons: Record<string, string> = {};
  if (blockedModelReasons && typeof blockedModelReasons === 'object')
    for (const [key, reason] of Object.entries(blockedModelReasons)) {
      const text = trimmed(reason);
      if (text) reasons[key] = text;
    }
  return {
    available: typeof available === 'boolean' ? available : true,
    message: trimmed(message),
    blockedModels: Array.isArray(blockedModels)
      ? blockedModels.map(trimmed).filter((k): k is string => k !== null)
      : [],
    blockedModelReasons: reasons,
  };
}

/** Whether a catalog key is down, and the note to show under "Temporarily unavailable". */
export function modelUnavailability(
  status: TrainingServiceStatus | null | undefined,
  key: string
): { reason: string | null } | null {
  if (!status?.blockedModels.includes(key)) return null;
  return { reason: status.blockedModelReasons[key] ?? null };
}

/** The model fields of a run (or a continuation's source run) that say what it trains on. */
export type RunModelRef = {
  ecosystem: string;
  modelVariant?: string;
  version?: string;
  model?: string;
  customModel?: string;
};

/** Why a run's model can't be trained right now (it, or its custom base, is blocked), or null. */
export function blockedRunMessage(
  run: RunModelRef,
  status: TrainingServiceStatus | null | undefined
): string | null {
  if (!status) return null;
  if (run.customModel && status.blockedModels.includes(run.customModel))
    return 'This custom model is blocked from training. Pick another.';
  // A run with no catalog AIR matches every version on its ecosystem (a keep-training source that
  // trained a custom base, say); it is refused only when all of them are down, so one blocked sibling
  // in a shared ecosystem (sdxl: SDXL, Illustrious, Pony) does not block the rest.
  const matches = versionsForRun(run);
  const downs = matches.map(({ version }) => modelUnavailability(status, version.key));
  if (matches.length === 0 || downs.some((d) => d === null)) return null;
  const reason = downs[0]!.reason;
  return `${matches[0]!.card.name} is ${UNAVAILABLE_LABEL.toLowerCase()} for training.${
    reason ? ` ${reason}` : ''
  }`;
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
