import { beforeEach, describe, expect, it } from 'vitest';
import { installFakeCacheRedis } from '~/__tests__/mocks/fake-cache-redis';
import { liveInstanceRevoked } from '~/server/registry-adapter/private-feed.live';
import { BlockRevocation } from '~/server/services/block-revocation.service';
import { subjectForUserId } from '~/server/services/block-token-subject';

/**
 * `liveInstanceRevoked` (`private-feed.live.ts`): the registry private feed's per-poll install
 * revocation check for a block-exchange token. Only the Redis layer is faked (the canonical
 * `redis` mock, backed by a key/value store); `BlockRevocation` and `subjectForUserId` are real,
 * and every marker is written by the real writer, so no key spelling is copied here.
 *
 * The subject-scoped case is the one that needs the subject: a `page_ephemeral-` id's ban marker
 * lives only under `user:<id>`, so a call that drops `subjectForUserId(userId)` reads the global
 * keys alone and answers false for the banned holder.
 */

// The one instance shape whose ban marker is subject-scoped (`isSubjectScopedInstanceId`).
const EPHEMERAL_ID = 'page_ephemeral-feed-probe';
const BANNED_USER = 4201;
const OTHER_USER = 4202;

describe('liveInstanceRevoked', () => {
  beforeEach(() => {
    installFakeCacheRedis();
  });

  it('is false when no marker exists (baseline)', async () => {
    await expect(liveInstanceRevoked(EPHEMERAL_ID, BANNED_USER)).resolves.toBe(false);
  });

  it('reads the subject-scoped ban marker for that user only', async () => {
    await BlockRevocation.revokeInstanceForBan(EPHEMERAL_ID, {
      subject: subjectForUserId(BANNED_USER),
    });

    await expect(liveInstanceRevoked(EPHEMERAL_ID, BANNED_USER)).resolves.toBe(true);
    // Negative control: another author holding the same unclaimed slug is not refused.
    await expect(liveInstanceRevoked(EPHEMERAL_ID, OTHER_USER)).resolves.toBe(false);
  });

  it('honours a global ban marker for every user', async () => {
    await BlockRevocation.revokeInstanceForBan(EPHEMERAL_ID);

    await expect(liveInstanceRevoked(EPHEMERAL_ID, BANNED_USER)).resolves.toBe(true);
    await expect(liveInstanceRevoked(EPHEMERAL_ID, OTHER_USER)).resolves.toBe(true);
  });

  it('honours a global install marker on a globally unique instance id', async () => {
    await BlockRevocation.revokeInstance('bki_feed_probe');

    await expect(liveInstanceRevoked('bki_feed_probe', BANNED_USER)).resolves.toBe(true);
    await expect(liveInstanceRevoked('bki_other_probe', BANNED_USER)).resolves.toBe(false);
  });
});
