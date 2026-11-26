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

// civitai/civitai#10097: a non-Scanned row the shared block rule keeps asks deny, never more.
describe('access for a row the scan write keeps', () => {
  it.each([
    ['an errored row with a CSAM reason', row({ blockedFor: 'CSAM', keptRow: true })],
    ['an errored row with a moderated reason', row({ blockedFor: 'moderated', keptRow: true })],
    [
      'an errored row that is also held',
      row({ blockedFor: 'moderated', keptRow: true, held: true }),
    ],
    ['an errored row kept by a marker with no reason', row({ keptRow: true })],
    ['a pending kept row', row({ ingestion: 'Pending', blockedFor: 'moderated', keptRow: true })],
    ['a rescan kept row', row({ ingestion: 'Rescan', blockedFor: 'moderated', keptRow: true })],
    [
      'a manual-assignment kept row',
      row({ ingestion: 'PendingManualAssignment', blockedFor: 'moderated', keptRow: true }),
    ],
    [
      'a not-found kept row',
      row({ ingestion: 'NotFound', blockedFor: 'moderated', keptRow: true }),
    ],
  ])('denies %s', (_label, image) => {
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
    ['an errored row awaiting verification', row({ blockedFor: 'AiNotVerified' })],
    ['a scanned row, whatever the rule says', row({ ingestion: 'Scanned', keptRow: true })],
  ])('allows %s, as before', (_label, image) => {
    expect(desiredImageAccess(image)).toBe('allow');
  });
});
