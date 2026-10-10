import { createHash, createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import { env } from '~/env/server';
import {
  hatField,
  hatTopicId,
  previewTopicId,
  seasonHatTopicId,
  seasonTeamsTopic,
  seasonTeamsTopicId,
} from '~/server/events/points/keys';

/**
 * Topic ids. The live season's are named by public facts (a hash of the hat), so anyone can subscribe
 * to them. The preview's must not be guessable: keyed with a server secret, so only a read the
 * preview allows can hand one out.
 */

const HAT = { ownerId: 9, cosmeticId: 31, claimKey: 'claimed' };

describe('topic ids', () => {
  it('live: the public hash of the hat, as before the preview had ids', () => {
    const publicId = createHash('sha256').update('9:31:claimed').digest('hex').slice(0, 16);
    expect(hatTopicId(HAT)).toBe(publicId);
    expect(seasonHatTopicId('birthday2026', HAT, 'live')).toBe(publicId);
    expect(seasonTeamsTopicId('birthday2026', 'live')).toBe('teams');
    expect(seasonTeamsTopic('birthday2026', 'teams')).toBe('event-points:birthday2026:teams');
  });

  it('preview: 128 bits of an HMAC keyed with the server secret, over the event and the member', () => {
    expect(env.NEXTAUTH_SECRET.length).toBeGreaterThan(0);
    const keyed = (member: string) =>
      createHmac('sha256', env.NEXTAUTH_SECRET)
        .update(`event-points:preview:birthday2026:${member}`)
        .digest('hex')
        .slice(0, 32);
    expect(seasonHatTopicId('birthday2026', HAT, 'preview')).toBe(keyed(hatField(HAT)));
    expect(seasonTeamsTopicId('birthday2026', 'preview')).toBe(keyed('teams'));
    expect(previewTopicId('birthday2026', 'teams')).toMatch(/^[0-9a-f]{32}$/);
    // Not the unkeyed hash a client could compute from the same facts.
    const unkeyed = createHash('sha256')
      .update(`event-points:preview:birthday2026:${hatField(HAT)}`)
      .digest('hex')
      .slice(0, 32);
    expect(seasonHatTopicId('birthday2026', HAT, 'preview')).not.toBe(unkeyed);
  });

  // The schema accepts any string: an empty or short key would make the ids computable by anyone.
  it('refuses to make a preview id without a real key, and live ids never need one', () => {
    const real = env.NEXTAUTH_SECRET;
    try {
      for (const key of ['', 'short']) {
        (env as { NEXTAUTH_SECRET: string }).NEXTAUTH_SECRET = key;
        expect(() => previewTopicId('birthday2026', 'teams')).toThrow(
          'No server secret to key preview topic ids with'
        );
        expect(seasonHatTopicId('birthday2026', HAT, 'live')).toBe(hatTopicId(HAT));
        expect(seasonTeamsTopicId('birthday2026', 'live')).toBe('teams');
      }
    } finally {
      (env as { NEXTAUTH_SECRET: string }).NEXTAUTH_SECRET = real;
    }
    // The control: with the real key back, it makes one.
    expect(previewTopicId('birthday2026', 'teams')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('preview ids differ from live ones, between events and between hats, and are stable', () => {
    const preview = seasonHatTopicId('birthday2026', HAT, 'preview');
    expect(preview).not.toBe(seasonHatTopicId('birthday2026', HAT, 'live'));
    expect(seasonHatTopicId('other', HAT, 'preview')).not.toBe(preview);
    expect(seasonHatTopicId('birthday2026', { ...HAT, claimKey: 'b' }, 'preview')).not.toBe(
      preview
    );
    expect(seasonHatTopicId('birthday2026', { ...HAT }, 'preview')).toBe(preview);
    const teams = seasonTeamsTopicId('birthday2026', 'preview');
    expect(seasonTeamsTopic('birthday2026', teams)).toBe(
      `event-points:birthday2026:teams:${teams}`
    );
  });
});
