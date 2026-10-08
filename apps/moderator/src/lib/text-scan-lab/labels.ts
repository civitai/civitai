import type { LabEntityType, LabLabel, NsfwLevelName, PromptKey } from './types';

export const LABEL_NAMES: Record<LabLabel, string> = {
  nsfw: 'Rating',
  poi: 'Real person',
  minor: 'Minor',
  scam: 'Scam / phishing',
};

export const promptKeyName = (key: PromptKey): string =>
  key === 'base'
    ? 'General instructions'
    : `${LABEL_NAMES[key.replace(/^label:/, '') as LabLabel]} definition`;

export const blankPromptKeys = (prompts: Partial<Record<PromptKey, unknown>>): PromptKey[] =>
  (Object.keys(prompts) as PromptKey[]).filter((k) => {
    const v = prompts[k];
    return typeof v !== 'string' || !v.trim();
  });

export const describeBlankPrompts = (keys: readonly PromptKey[]): string =>
  `${keys.map(promptKeyName).join(', ')} ${
    keys.length === 1 ? 'is' : 'are'
  } empty — write it, or reset it to current.`;

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

/** `neutral`: a rating is information, not a finding. */
export type VerdictTone = 'clear' | 'neutral' | 'flagged' | 'unknown';
export type Verdict = { headline: string; tone: VerdictTone; reason?: string };

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
    if (!Object.hasOwn(RATING_NAMES, level))
      return couldNotJudge(`unknown rating ${String(v.level)}`);
    return { headline: `Rated ${RATING_NAMES[level]}`, tone: 'neutral', reason };
  }

  if (typeof v.detected !== 'boolean') return couldNotJudge(`no ${LABEL_NAMES[label]} answer`);
  const phrase = FLAG_PHRASES[label];
  if (!v.detected) return { headline: phrase.no, tone: 'clear', reason };
  const names =
    label === 'poi' && Array.isArray(v.names) && v.names.length ? `: ${v.names.join(', ')}` : '';
  return { headline: `${phrase.yes}${names}`, tone: 'flagged', reason };
}

/** Whether two results give a different verdict on `label`: the rating, or the yes or no — never the
 *  reason or poi's names. Two results without a verdict do not differ. */
export function verdictsDiffer(label: LabLabel, a: VerdictSource, b: VerdictSource): boolean {
  const verdictOf = (source: VerdictSource) => {
    const v = describeVerdict(label, source);
    if (v.tone === 'unknown') return null;
    return label === 'nsfw' ? v.headline : v.tone;
  };
  return verdictOf(a) !== verdictOf(b);
}
