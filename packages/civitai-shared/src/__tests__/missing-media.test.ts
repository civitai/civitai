import { describe, expect, it, vi } from 'vitest';
import {
  assertMediaPresentForPublish,
  isProbeableMediaKey,
  decideMediaPublish,
  IMAGE_SCAN_FAILURE_CLASS_PERMANENT,
  MediaPresence,
  MISSING_MEDIA_PUBLISH_MESSAGE,
  MissingMediaError,
} from '../missing-media';

/**
 * The rule both `resolveIngestionError` implementations delegate to. Expectations here are pinned
 * LITERALLY rather than derived from the module, so a change to the implementation shows up as a
 * failing test instead of a test that quietly agrees with whatever the code now does.
 */
describe('decideMediaPublish', () => {
  /**
   * Exhaustive over the value set, as a table. The mutant this catches and a per-case test does
   * not: swapping which verdict refuses. Every row is a distinct outcome, so no single flipped
   * comparison leaves the table green.
   */
  it('refuses exactly one of the three verdicts', () => {
    expect(decideMediaPublish('absent')).toEqual({
      allow: false,
      presence: 'absent',
      message: MISSING_MEDIA_PUBLISH_MESSAGE,
    });
    expect(decideMediaPublish('present')).toEqual({ allow: true, presence: 'present' });
    expect(decideMediaPublish('unknown')).toEqual({ allow: true, presence: 'unknown' });
  });

  it('names the three verdicts with the strings the storage layers speak', () => {
    // Pinned as literals: the probes in both runtimes build these strings from their own client's
    // answer, so renaming a member here without updating them would silently make every probe
    // return an unrecognised value that falls through to "allow".
    expect(MediaPresence.Present).toBe('present');
    expect(MediaPresence.Absent).toBe('absent');
    expect(MediaPresence.Unknown).toBe('unknown');
  });

  it('exports the stored scan-failure class the missing-media queue keys off', () => {
    expect(IMAGE_SCAN_FAILURE_CLASS_PERMANENT).toBe('permanent');
  });

  it('gives the moderator a message that says what to do instead', () => {
    // Pinned whole, not by keyword: a guard on WORDS is walkable by rewording. This is the string
    // a moderator sees, so the test owns it and a copy change has to come here.
    expect(MISSING_MEDIA_PUBLISH_MESSAGE).toBe(
      'The media file for this image is missing from storage, so it cannot be published — publishing it would put a permanently broken image on the site. Delete it, or ask the uploader to upload it again.'
    );
  });
});

describe('assertMediaPresentForPublish', () => {
  it('throws MissingMediaError when the store answered ABSENT', async () => {
    const probe = vi.fn(async () => MediaPresence.Absent);
    await expect(assertMediaPresentForPublish({ probe })).rejects.toThrow(MissingMediaError);
    await expect(assertMediaPresentForPublish({ probe })).rejects.toThrow(
      MISSING_MEDIA_PUBLISH_MESSAGE
    );
  });

  it('allows and does not log when the store answered PRESENT', async () => {
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      probe: async () => MediaPresence.Present,
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'present' });
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it('allows and logs when the store ANSWERED unknown', async () => {
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      probe: async () => MediaPresence.Unknown,
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'unknown' });
    expect(onUnknown).toHaveBeenCalledTimes(1);
    // No error to report — the probe returned a verdict rather than failing.
    expect(onUnknown).toHaveBeenCalledWith(undefined);
  });

  it('allows and logs the error when the probe THREW', async () => {
    // The fail-open case. Inability to consult the store is not evidence of loss, and rejecting on
    // it would let a storage blip block moderation on the queue whose job is unblocking content.
    const boom = new Error('credentials not configured');
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      probe: async () => {
        throw boom;
      },
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'unknown' });
    expect(onUnknown).toHaveBeenCalledWith(boom);
  });

  it('allows when the probe throws SYNCHRONOUSLY, e.g. a storage client that cannot be built', async () => {
    // `getB2ImageS3Client()` throws on construction when credentials are absent, and the main app's
    // probe builds it inline. A try that only covered the await would let that escape as a 500 on a
    // publish that should have been allowed.
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      probe: () => {
        throw new Error('B2 image upload credentials not configured');
      },
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'unknown' });
    expect(onUnknown).toHaveBeenCalledTimes(1);
  });

  it('uses the caller-supplied raise for the refusal, so each runtime throws its own error type', async () => {
    class Trpcish extends Error {}
    const raise = vi.fn((message: string) => {
      throw new Trpcish(message);
    });
    await expect(
      assertMediaPresentForPublish({ probe: async () => MediaPresence.Absent, raise })
    ).rejects.toThrow(Trpcish);
    expect(raise).toHaveBeenCalledWith(MISSING_MEDIA_PUBLISH_MESSAGE);
  });

  it('still refuses when a supplied raise returns instead of throwing', async () => {
    // The backstop. A `raise` that merely returns would otherwise fall through and publish the
    // broken image — the exact defect this module exists to remove.
    const raise = vi.fn(() => undefined);
    await expect(
      assertMediaPresentForPublish({ probe: async () => MediaPresence.Absent, raise })
    ).rejects.toThrow(MissingMediaError);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('never calls raise on a verdict that allows', async () => {
    const raise = vi.fn(() => {
      throw new Error('should not be reached');
    });
    for (const presence of [MediaPresence.Present, MediaPresence.Unknown]) {
      await expect(
        assertMediaPresentForPublish({ probe: async () => presence, raise })
      ).resolves.toMatchObject({ allow: true });
    }
    expect(raise).not.toHaveBeenCalled();
  });
});

/**
 * The regression this predicate exists for. `Image.url` is a bucket key for MOST rows, not all:
 * profile pictures may store a whitelisted external avatar CDN url verbatim, and those rows are
 * created and ingested like any other, so they carry a current timestamp and reach the review
 * queue. A legacy bug also persisted `blob:` handles.
 *
 * Handing one of those to the bucket as a Key 404s, which the store reports as `absent` — so
 * without this the guard REFUSES, permanently and with no override, an image that renders fine.
 * That is worse than the bug the guard fixes, so these cases are pinned literally.
 */
describe('isProbeableMediaKey', () => {
  it('accepts the bare object keys that are the overwhelming majority', () => {
    expect(isProbeableMediaKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee')).toBe(true);
    // Keys with a path, and a colon appearing LATER, are still keys — a scheme cannot contain `/`.
    expect(isProbeableMediaKey('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/width=450')).toBe(true);
    expect(isProbeableMediaKey('some/path:with-a-colon')).toBe(true);
  });

  it('rejects every external-avatar CDN url the profile-picture path whitelists', () => {
    // These four prefixes are the ones `verifyAvatar` accepts, written out rather than generated,
    // so a change to that whitelist has to be reflected here deliberately.
    for (const url of [
      'https://cdn.discordapp.com/avatars/123/abc.png',
      'https://cdn.discordapp.com/embed/avatars/1.png',
      'https://avatars.githubusercontent.com/u/12345',
      'https://lh3.googleusercontent.com/a/AAcHTtd',
    ]) {
      expect(isProbeableMediaKey(url), url).toBe(false);
    }
  });

  it('rejects the legacy blob: population, which is what made the two runtimes disagree', () => {
    expect(isProbeableMediaKey('blob:https://civitai.com/9f8e-1234')).toBe(false);
  });

  it('rejects http, data: and an empty or absent url', () => {
    expect(isProbeableMediaKey('http://example.com/x.png')).toBe(false);
    expect(isProbeableMediaKey('data:image/png;base64,AAAA')).toBe(false);
    expect(isProbeableMediaKey('')).toBe(false);
    expect(isProbeableMediaKey(null)).toBe(false);
    expect(isProbeableMediaKey(undefined)).toBe(false);
  });
});

describe('assertMediaPresentForPublish — refusal is observable', () => {
  it('reports every refusal, so a fail-CLOSED misconfiguration cannot hide', () => {
    // The mirror of the unknown-logging case: a wrong bucket name 404s for every key, which reads
    // as `absent` for every image. Without this hook that is indistinguishable from a clean run.
    const onRefused = vi.fn();
    return expect(
      assertMediaPresentForPublish({ probe: async () => MediaPresence.Absent, onRefused })
    )
      .rejects.toThrow(MissingMediaError)
      .then(() => expect(onRefused).toHaveBeenCalledTimes(1));
  });

  it('never reports a refusal on a verdict that allows', async () => {
    const onRefused = vi.fn();
    for (const presence of [MediaPresence.Present, MediaPresence.Unknown]) {
      await assertMediaPresentForPublish({ probe: async () => presence, onRefused });
    }
    expect(onRefused).not.toHaveBeenCalled();
  });
});
