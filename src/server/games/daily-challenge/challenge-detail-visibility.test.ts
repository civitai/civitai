import { describe, expect, it } from 'vitest';
import {
  ChallengeIngestionStatus,
  ChallengeSource,
  ChallengeStatus,
  ImageIngestionStatus,
} from '~/shared/utils/prisma/enums';
import { isChallengeDetailHidden } from './challenge-detail-visibility';

describe('isChallengeDetailHidden', () => {
  const OWNER = 111;
  const OTHER = 333;
  const NOW = new Date('2030-01-11T00:00:00Z');
  const challenge = (overrides: Partial<Parameters<typeof isChallengeDetailHidden>[0]> = {}) => ({
    source: ChallengeSource.User,
    createdById: OWNER,
    visibleAt: new Date('2020-01-01T00:00:00Z'),
    status: ChallengeStatus.Scheduled,
    ingestion: ChallengeIngestionStatus.Scanned,
    buzzType: 'yellow' as const,
    coverImageId: null,
    ...overrides,
  });
  const viewer = (overrides: Partial<Parameters<typeof isChallengeDetailHidden>[1]> = {}) => ({
    id: OTHER,
    canAccessUserChallenges: true,
    blockedByCreator: false,
    ...overrides,
  });
  const moderator = viewer({ id: 222, isModerator: true });
  const owner = viewer({ id: OWNER });
  const anonymous = viewer({ id: undefined });
  const hidden = (
    c: ReturnType<typeof challenge>,
    v: ReturnType<typeof viewer>,
    cover: Parameters<typeof isChallengeDetailHidden>[2] = null
  ) => isChallengeDetailHidden(c, v, cover, NOW);

  it('hides user challenges from everyone, owner and moderators included, without the flag', () => {
    const noFlag = { canAccessUserChallenges: false };
    expect(hidden(challenge(), viewer(noFlag))).toBe(true);
    expect(hidden(challenge(), { ...owner, ...noFlag })).toBe(true);
    expect(hidden(challenge(), { ...moderator, ...noFlag })).toBe(true);
    expect(hidden(challenge({ source: ChallengeSource.System }), viewer(noFlag))).toBe(false);
  });

  it('hides a user challenge from a viewer its creator blocked, except a moderator', () => {
    expect(hidden(challenge(), viewer({ blockedByCreator: true }))).toBe(true);
    expect(hidden(challenge(), viewer())).toBe(false);
    expect(hidden(challenge(), { ...moderator, blockedByCreator: true })).toBe(false);
    expect(
      hidden(challenge({ source: ChallengeSource.System }), viewer({ blockedByCreator: true }))
    ).toBe(false);
  });

  it('shows an unscanned user challenge to its owner and moderators only', () => {
    const pending = challenge({ ingestion: ChallengeIngestionStatus.Pending });
    expect(hidden(pending, owner)).toBe(false);
    expect(hidden(pending, moderator)).toBe(false);
    expect(hidden(pending, viewer())).toBe(true);
    expect(hidden(pending, anonymous)).toBe(true);
  });

  it('hides a POI, unscanned or unrated cover from other viewers, not from a moderator', () => {
    const withCover = challenge({ coverImageId: 77 });
    const scanned = { poi: false, ingestion: ImageIngestionStatus.Scanned, nsfwLevel: 1 };
    expect(hidden(withCover, viewer(), scanned)).toBe(false);
    expect(hidden(withCover, viewer(), { ...scanned, poi: true })).toBe(true);
    expect(hidden(withCover, viewer(), { ...scanned, nsfwLevel: 0 })).toBe(true);
    const pendingCover = { ...scanned, ingestion: ImageIngestionStatus.Pending };
    expect(hidden(withCover, viewer(), pendingCover)).toBe(true);
    expect(hidden(withCover, moderator, { ...scanned, poi: true })).toBe(false);
    expect(hidden(withCover, moderator, pendingCover)).toBe(false);
  });

  it('on red hides a green challenge from other viewers; on green returns a yellow one to anyone', () => {
    const green = challenge({ buzzType: 'green' });
    expect(hidden(green, viewer())).toBe(true);
    expect(hidden(green, anonymous)).toBe(true);
    expect(hidden(green, owner)).toBe(false);
    expect(hidden(green, moderator)).toBe(false);
    expect(hidden(challenge(), viewer({ isGreen: true }))).toBe(false);
    expect(hidden(challenge(), viewer({ id: undefined, isGreen: true }))).toBe(false);
  });
});
