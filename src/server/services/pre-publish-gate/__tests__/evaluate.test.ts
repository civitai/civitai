import { describe, expect, it } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import {
  decidePrePublishGate,
  PENDING_IMAGE_MAX_AGE_MS,
  type GateImage,
  type GateInput,
} from '~/server/services/pre-publish-gate/evaluate';
import { ImageIngestionStatus } from '~/shared/utils/prisma/enums';

const NOW = new Date('2026-11-09T12:00:00Z');
const image = (over: Partial<GateImage> = {}): GateImage => ({
  id: 1,
  ingestion: ImageIngestionStatus.Scanned,
  nsfwLevel: NsfwLevel.PG,
  minor: false,
  poi: false,
  needsReview: null,
  createdAt: new Date(NOW.getTime() - 60_000),
  ...over,
});
const input = (over: Partial<GateInput> = {}): GateInput => ({
  model: { nsfw: false, poi: false, poiFlagOpen: false },
  images: [image()],
  textVerdict: 'clear',
  now: NOW,
  ...over,
});
const decide = (over: Partial<GateInput> = {}) => decidePrePublishGate(input(over));

describe('decidePrePublishGate', () => {
  it('passes a clean model with scanned images and a clear text scan (control)', () => {
    expect(decide().outcome).toBe('pass');
  });

  it.each([
    ImageIngestionStatus.Pending,
    ImageIngestionStatus.Rescan,
    ImageIngestionStatus.PendingManualAssignment,
  ])('waits while a showcase image is %s', (ingestion) => {
    expect(decide({ images: [image(), image({ id: 2, ingestion })] }).outcome).toBe('pending');
  });

  it('waits on an image marked scanned that has no rating yet', () => {
    expect(decide({ images: [image({ nsfwLevel: 0 })] }).outcome).toBe('pending');
  });

  it('refuses an image still unscanned after the cutoff, as a failed scan', () => {
    const old = new Date(NOW.getTime() - PENDING_IMAGE_MAX_AGE_MS - 1);
    const decision = decide({
      images: [image({ ingestion: ImageIngestionStatus.Pending, createdAt: old })],
    });
    expect(decision).toMatchObject({ outcome: 'refused', refusal: 'image_error' });
  });

  it.each([ImageIngestionStatus.Error, ImageIngestionStatus.NotFound])(
    'refuses a %s image rather than sending it to a moderator',
    (ingestion) => {
      expect(decide({ images: [image({ ingestion })] })).toMatchObject({
        outcome: 'refused',
        refusal: 'image_error',
      });
    }
  );

  it.each([
    ['a blocked image', { ingestion: ImageIngestionStatus.Blocked }],
    ['a mature image', { nsfwLevel: NsfwLevel.R }],
    ['an explicit image', { nsfwLevel: NsfwLevel.X }],
    ['an image flagged minor', { minor: true }],
  ])('refuses %s', (_, over) => {
    expect(decide({ images: [image(), image({ id: 2, ...over })] })).toMatchObject({
      outcome: 'refused',
      refusal: 'images',
    });
  });

  it('passes a PG-13 image (control for the level check)', () => {
    expect(decide({ images: [image({ nsfwLevel: NsfwLevel.PG13 })] }).outcome).toBe('pass');
  });

  it.each([
    ['a real-person image', { poi: true }],
    ['an image in moderator review', { needsReview: 'poi' }],
  ])('holds %s for a moderator', (_, over) => {
    expect(decide({ images: [image(over)] }).outcome).toBe('held');
  });

  it('refuses a model with no showcase images', () => {
    expect(decide({ images: [] })).toMatchObject({ outcome: 'refused', refusal: 'no_images' });
  });

  it.each([
    [
      'the model is marked as a real person',
      { model: { nsfw: false, poi: true, poiFlagOpen: false } },
    ],
    ['an open real-person text flag', { model: { nsfw: false, poi: false, poiFlagOpen: true } }],
    ['a real-person hit in the gate text scan', { textVerdict: 'hit' as const }],
    ['a text scan that cannot run', { textVerdict: 'unavailable' as const }],
  ])('holds for a moderator when %s', (_, over) => {
    expect(decide(over).outcome).toBe('held');
  });

  it('waits for its own text scan', () => {
    expect(decide({ textVerdict: 'pending' }).outcome).toBe('pending');
  });

  it('refuses a model self-flagged NSFW before anything else', () => {
    expect(
      decide({ model: { nsfw: true, poi: true, poiFlagOpen: false }, textVerdict: 'pending' })
    ).toMatchObject({ outcome: 'refused', refusal: 'nsfw' });
  });

  it('lets a refusal win over a hold and a wait, and a wait over a hold', () => {
    const blocked = image({ id: 2, ingestion: ImageIngestionStatus.Blocked });
    const pending = image({ id: 3, ingestion: ImageIngestionStatus.Pending });
    expect(decide({ images: [blocked, pending], textVerdict: 'hit' }).outcome).toBe('refused');
    expect(decide({ images: [pending], textVerdict: 'hit' }).outcome).toBe('pending');
  });
});
