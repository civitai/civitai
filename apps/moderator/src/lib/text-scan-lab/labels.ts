import { caseCorrect } from './score';
import type { Expected, LabEntityType, LabLabel, NsfwLevelName, PromptKey } from './types';

export const LABEL_NAMES: Record<LabLabel, string> = {
  nsfw: 'Rating',
  poi: 'Real person',
  minor: 'Minor',
  scam: 'Scam / phishing',
};

export const promptKeyName = (key: PromptKey): string =>
  key === 'base' ? 'General instructions' : `${LABEL_NAMES[key.slice(6) as LabLabel]} definition`;

export const ENTITY_TYPE_NAMES: Record<LabEntityType, string> = {
  Model: 'Model',
  Article: 'Article',
  Post: 'Post',
  Bounty: 'Bounty',
  BountyEntry: 'Bounty entry',
  Challenge: 'Challenge',
  Crucible: 'Crucible',
  Collection: 'Collection',
  ChatMessage: 'Chat messages',
  Comment: 'Model comment (old)',
  CommentV2: 'Comment',
  ResourceReview: 'Review',
  User: 'Username',
  UserProfile: 'Profile',
};

export const RATING_NAMES: Record<NsfwLevelName, string> = {
  none: 'PG',
  pg13: 'PG-13',
  r: 'R',
  x: 'X',
  xxx: 'XXX',
};

const FLAG_PHRASES: Record<Exclude<LabLabel, 'nsfw'>, { yes: string; no: string }> = {
  poi: { yes: 'Names a real person', no: 'No real person' },
  minor: { yes: 'Involves a minor', no: 'No minor' },
  scam: { yes: 'Scam', no: 'Not a scam' },
};

export type VerdictTone = 'clear' | 'caution' | 'flagged' | 'unknown';
export type Verdict = { headline: string; tone: VerdictTone; reason?: string };

/** A scan result, or a test-set run row mapped to one. `LabScanResult` fits. */
export type VerdictSource =
  | { ok: true; output: Record<string, unknown> | null; parseError?: string }
  | { ok: false; error: string };

const couldNotJudge = (why: string): Verdict => ({
  headline: `Couldn't judge: ${why}`,
  tone: 'unknown',
});

export function describeVerdict(label: LabLabel, source: VerdictSource): Verdict {
  if (!source.ok) return couldNotJudge(source.error);
  if (!source.output) return couldNotJudge(source.parseError ?? 'no answer');
  const v = source.output[label] as
    | { level?: unknown; detected?: unknown; names?: unknown; reason?: unknown }
    | undefined;
  if (!v || typeof v !== 'object') return couldNotJudge(`no ${LABEL_NAMES[label]} answer`);
  const reason = typeof v.reason === 'string' && v.reason.trim() ? v.reason.trim() : undefined;

  if (label === 'nsfw') {
    const level = v.level as NsfwLevelName;
    if (!(level in RATING_NAMES)) return couldNotJudge(`unknown rating ${String(v.level)}`);
    const tone: VerdictTone = level === 'none' ? 'clear' : level === 'pg13' ? 'caution' : 'flagged';
    return { headline: `Rated ${RATING_NAMES[level]}`, tone, reason };
  }

  if (typeof v.detected !== 'boolean') return couldNotJudge(`no ${LABEL_NAMES[label]} answer`);
  const phrase = FLAG_PHRASES[label];
  if (!v.detected) return { headline: phrase.no, tone: 'clear', reason };
  const names =
    label === 'poi' && Array.isArray(v.names) && v.names.length ? `: ${v.names.join(', ')}` : '';
  return { headline: `${phrase.yes}${names}`, tone: 'flagged', reason };
}

function describeRange({ min, max }: NonNullable<Expected['nsfw']>): string {
  if (min === max) return RATING_NAMES[min];
  if (min === 'none' && max === 'xxx') return 'Any rating';
  if (min === 'none') return `${RATING_NAMES[max]} or lower`;
  if (max === 'xxx') return `${RATING_NAMES[min]} or higher`;
  return `${RATING_NAMES[min]} to ${RATING_NAMES[max]}`;
}

/** Each scored label's expectation in plain words ("PG-13 or lower", "Not a scam"); unscored labels
 *  are absent. */
export function describeExpected(expected: Expected): Partial<Record<LabLabel, string>> {
  const out: Partial<Record<LabLabel, string>> = {};
  if (expected.nsfw) out.nsfw = describeRange(expected.nsfw);
  for (const label of ['poi', 'minor', 'scam'] as const) {
    const want = expected[label];
    if (want !== undefined) out[label] = want ? FLAG_PHRASES[label].yes : FLAG_PHRASES[label].no;
  }
  return out;
}

/** Whether a verdict met a test case's expectation, or null when the label is unscored or there is no
 *  verdict to check. */
export function checkExpected(
  expected: Expected,
  label: LabLabel,
  source: VerdictSource
): { asExpected: boolean; expected: string } | null {
  const want = describeExpected(expected)[label];
  if (!want || !source.ok || !source.output) return null;
  if (describeVerdict(label, source).tone === 'unknown') return null;
  const correct = caseCorrect(expected, source.output)[label];
  return correct === undefined ? null : { asExpected: correct, expected: want };
}
