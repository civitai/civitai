import {
  BLOCKED_CUSTOM_MODEL_MESSAGE,
  isBlockedCustomModel,
} from '@civitai/shared/training-custom-model';
import { ecosystemDefaultVersion, findByAir, MODEL_CARDS } from './data/trainingModels';

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

const CATALOG_KEYS = new Set(MODEL_CARDS.flatMap((c) => c.versions.map((v) => v.key)));

/** The status the browser gets: blocked catalog models and their notes only. Blocked custom-model AIRs
 *  stay server-side, where the submit refuses them. */
export function clientServiceStatus(status: TrainingServiceStatus): TrainingServiceStatus {
  const blockedModels = status.blockedModels.filter((key) => CATALOG_KEYS.has(key));
  return {
    ...status,
    blockedModels,
    blockedModelReasons: Object.fromEntries(
      blockedModels
        .filter((key) => status.blockedModelReasons[key])
        .map((key) => [key, status.blockedModelReasons[key]!])
    ),
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
  // The checkpoint the run trains, as the submit sends it: a custom base wins over the pinned base AIR,
  // and a run naming neither trains on the ecosystem's default base.
  const trained = run.customModel || run.model;
  if (trained && isBlockedCustomModel(trained)) return BLOCKED_CUSTOM_MODEL_MESSAGE;
  if (!status) return null;
  const match = trained ? findByAir(trained) : ecosystemDefaultVersion(run);
  if (!match) {
    // Not a catalog checkpoint: a custom base, refused only when that AIR itself is blocked.
    return trained && status.blockedModels.includes(trained) ? BLOCKED_CUSTOM_MODEL_MESSAGE : null;
  }
  const down = modelUnavailability(status, match.version.key);
  if (!down) return null;
  return `${match.card.name} is ${UNAVAILABLE_LABEL.toLowerCase()} for training.${
    down.reason ? ` ${down.reason}` : ''
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
