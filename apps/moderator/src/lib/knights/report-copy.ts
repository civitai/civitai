import { KNIGHTS_REPORT_REASONS, type KnightsReportReason } from '@civitai/shared/new-order';
import { plural } from '$lib/format';

const lower = (label: string) => label.charAt(0).toLowerCase() + label.slice(1);

/** "Reported by 6 players: 4 problem with the image, 2 problem with the question"; a lone reason goes without its number. */
export function reportBreakdown(counts: Record<KnightsReportReason, number>): string {
  const given = KNIGHTS_REPORT_REASONS.filter((reason) => counts[reason.value] > 0);
  const total = given.reduce((sum, reason) => sum + counts[reason.value], 0);
  const reasons =
    given.length === 1
      ? lower(given[0].label)
      : given.map((reason) => `${counts[reason.value]} ${lower(reason.label)}`).join(', ');
  return `Reported by ${plural(total, 'player')}: ${reasons}`;
}

/** What a pulled image's main-app report filing says, by `KnightsImagePull.filing`; a filed one is a link instead. */
export const FILING_TEXT = {
  pending: 'Image report pending: Knights will file it shortly.',
  'not-needed': 'No image report needed: the image no longer exists.',
} as const;

const NOUNS = {
  core: ['core image', 'core images'],
  fresh: ['fresh image', 'fresh images'],
  'spot-check': ['image to spot-check', 'images to spot-check'],
  'yes-no': ['pair', 'pairs'],
  questions: ['question', 'questions'],
} as const;

export type TrialsTab = keyof typeof NOUNS;

/** The noun after a Trials tab's result count: singular for exactly one. */
export const trialsCount = (tab: TrialsTab, count: number): string =>
  NOUNS[tab][count === 1 ? 0 : 1];

/** The plural noun of a Trials tab, for labels with no count. */
export const trialsNoun = (tab: TrialsTab): string => NOUNS[tab][1];
