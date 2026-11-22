import { describe, expect, it } from 'vitest';
import { desiredImageAccess, desiredUrlAccess, type ImageAccessFacts } from '../cdn-access.service';

const row = (over: Partial<ImageAccessFacts>): ImageAccessFacts => ({
  ownerId: 1,
  ingestion: 'Error',
  blockedFor: null,
  blockedAt: null,
  lastTakedownActivityAt: null,
  held: false,
  keptRow: false,
  post: null,
  ...over,
});

describe('access for a row the scan write keeps', () => {
  it.each([
    ['1', row({ blockedFor: 'CSAM', keptRow: true })],
    ['2', row({ blockedFor: 'moderated', keptRow: true })],
    ['3', row({ blockedFor: 'moderated', keptRow: true, held: true })],
    ['4', row({ keptRow: true })],
  ])('deny (%s)', (_label, image) => {
    expect(desiredImageAccess(image)).toBe('deny');
    expect(desiredUrlAccess({ images: [image], deletes: [] })).toBe('deny');
  });

  it('is capped at deny', () => {
    const at = new Date('2026-01-01T00:00:00Z');
    const image = row({
      blockedFor: 'moderated',
      keptRow: true,
      blockedAt: at,
      lastTakedownActivityAt: at,
    });
    expect(desiredImageAccess(image)).toBe('deny');
  });

  it.each([
    ['1', row({ blockedFor: 'AiNotVerified' })],
    ['2', row({ ingestion: 'Scanned', keptRow: true })],
  ])('allow, as before (%s)', (_label, image) => {
    expect(desiredImageAccess(image)).toBe('allow');
  });
});
