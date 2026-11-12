import { nsfwBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';
import type {
  CheckResult,
  GateDecision,
  GateOutcome,
  GateRefusal,
} from '~/server/services/pre-publish-gate/types';

/** An image still unscanned this long after upload is treated as a failed scan. */
export const PENDING_IMAGE_MAX_AGE_MS = 2 * 60 * 60 * 1000;

// Every gated base model's licence bars mature content, and the gate must hold before that licence
// record exists, so it does not read the licence's levels.
const REFUSED_LEVELS = nsfwBrowsingLevelsFlag;

const UNSCANNED: ImageIngestionStatus[] = [
  ImageIngestionStatus.Pending,
  ImageIngestionStatus.Rescan,
  ImageIngestionStatus.PendingManualAssignment,
];
const SCAN_FAILED: ImageIngestionStatus[] = [
  ImageIngestionStatus.Error,
  ImageIngestionStatus.NotFound,
];

export type GateImage = {
  id: number;
  ingestion: ImageIngestionStatus;
  nsfwLevel: number;
  minor: boolean;
  poi: boolean;
  needsReview: string | null;
  createdAt: Date;
};

/** The gate's own real-person text scan of the model, for the text as it is now. */
export type TextVerdict = 'clear' | 'hit' | 'pending' | 'unavailable';

export type GateInput = {
  model: { nsfw: boolean; poi: boolean; poiFlagOpen: boolean };
  images: GateImage[];
  textVerdict: TextVerdict;
  now: Date;
};

// A refusal is final and must not wait behind anything; a hold waits for the scans so the
// moderator decides on complete results.
const RANK: Record<GateOutcome, number> = { pass: 0, held: 1, pending: 2, refused: 3 };
const worst = (outcomes: GateOutcome[]) =>
  outcomes.reduce<GateOutcome>((a, b) => (RANK[b] > RANK[a] ? b : a), 'pass');

function checkImages(images: GateImage[], now: Date): CheckResult & { refusal?: GateRefusal } {
  if (!images.length) return { check: 'images', outcome: 'refused', refusal: 'no_images' };
  const refused: number[] = [];
  const failed: number[] = [];
  const pending: number[] = [];
  const review: number[] = [];
  for (const image of images) {
    // Scanned without a rating is not a final result yet.
    const unscanned =
      UNSCANNED.includes(image.ingestion) ||
      (image.ingestion === ImageIngestionStatus.Scanned && image.nsfwLevel === 0);
    if (
      SCAN_FAILED.includes(image.ingestion) ||
      (unscanned && now.getTime() - image.createdAt.getTime() > PENDING_IMAGE_MAX_AGE_MS)
    )
      failed.push(image.id);
    else if (unscanned) pending.push(image.id);
    else if (
      image.ingestion === ImageIngestionStatus.Blocked ||
      (image.nsfwLevel & REFUSED_LEVELS) !== 0 ||
      image.minor
    )
      refused.push(image.id);
    else if (image.poi || image.needsReview) review.push(image.id);
  }
  const detail = { imageIds: images.map((i) => i.id), refused, failed, pending, review };
  if (refused.length) return { check: 'images', outcome: 'refused', refusal: 'images', detail };
  if (failed.length) return { check: 'images', outcome: 'refused', refusal: 'image_error', detail };
  if (pending.length) return { check: 'images', outcome: 'pending', detail };
  if (review.length) return { check: 'images', outcome: 'held', detail };
  return { check: 'images', outcome: 'pass', detail };
}

function checkRealPerson(input: GateInput): CheckResult {
  const signals = {
    poi: input.model.poi,
    poiFlag: input.model.poiFlagOpen,
    textScan: input.textVerdict,
  };
  // No consent record exists for anyone, so every real-person signal goes to a moderator, as does a
  // scan that cannot run.
  if (
    signals.poi ||
    signals.poiFlag ||
    input.textVerdict === 'hit' ||
    input.textVerdict === 'unavailable'
  )
    return { check: 'real_person', outcome: 'held', detail: signals };
  if (input.textVerdict === 'pending')
    return { check: 'real_person', outcome: 'pending', detail: signals };
  return { check: 'real_person', outcome: 'pass', detail: signals };
}

export function decidePrePublishGate(input: GateInput): GateDecision {
  if (input.model.nsfw)
    return {
      outcome: 'refused',
      refusal: 'nsfw',
      checks: [{ check: 'nsfw', outcome: 'refused' }],
    };
  const images = checkImages(input.images, input.now);
  const realPerson = checkRealPerson(input);
  const { refusal, ...imageCheck } = images;
  const checks: CheckResult[] = [{ check: 'nsfw', outcome: 'pass' }, imageCheck, realPerson];
  const outcome = worst(checks.map((c) => c.outcome));
  return { outcome, checks, ...(outcome === 'refused' && refusal ? { refusal } : {}) };
}
