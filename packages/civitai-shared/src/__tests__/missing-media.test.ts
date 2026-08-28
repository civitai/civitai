import { describe, expect, it, vi } from 'vitest';
import {
  assertMediaPresentForPublish,
  decideMediaPublish,
  IMAGE_SCAN_FAILURE_CLASS_PERMANENT,
  isUnrenderableMediaUrl,
  MEDIA_PROBE_ERROR_MAX_LENGTH,
  MediaPresence,
  MISSING_MEDIA_PUBLISH_MESSAGE,
  MissingMediaError,
  summarizeProbeError,
  UNRENDERABLE_MEDIA_PUBLISH_MESSAGE,
} from '../missing-media';

/** A url that reaches the probe. Every case that must NOT be short-circuited uses this one. */
const KEY = '0f8fad5b-d9cb-469f-a165-70867728950e';

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
  it('refuses exactly two of the five verdicts, each with its own message', () => {
    expect(decideMediaPublish('absent')).toEqual({
      allow: false,
      presence: 'absent',
      message: MISSING_MEDIA_PUBLISH_MESSAGE,
    });
    expect(decideMediaPublish('unrenderable')).toEqual({
      allow: false,
      presence: 'unrenderable',
      message: UNRENDERABLE_MEDIA_PUBLISH_MESSAGE,
    });
    expect(decideMediaPublish('present')).toEqual({ allow: true, presence: 'present' });
    expect(decideMediaPublish('unknown')).toEqual({ allow: true, presence: 'unknown' });
    expect(decideMediaPublish('not-applicable')).toEqual({
      allow: true,
      presence: 'not-applicable',
    });
  });

  it('gives the two refusals DIFFERENT messages, because they have different remedies', () => {
    // Folding them onto one string would tell a moderator to go looking in storage for a file that
    // was never uploaded there.
    expect(MISSING_MEDIA_PUBLISH_MESSAGE).not.toBe(UNRENDERABLE_MEDIA_PUBLISH_MESSAGE);
  });

  it('names the five verdicts with the strings the storage layers speak', () => {
    // Pinned as literals: the probes in both runtimes build these strings from their own client's
    // answer, so renaming a member here without updating them would silently make every probe
    // return an unrecognised value that falls through to "allow".
    expect(MediaPresence.Present).toBe('present');
    expect(MediaPresence.Absent).toBe('absent');
    expect(MediaPresence.Unknown).toBe('unknown');
    expect(MediaPresence.NotApplicable).toBe('not-applicable');
    expect(MediaPresence.Unrenderable).toBe('unrenderable');
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
    await expect(assertMediaPresentForPublish({ url: KEY, probe })).rejects.toThrow(
      MissingMediaError
    );
    await expect(assertMediaPresentForPublish({ url: KEY, probe })).rejects.toThrow(
      MISSING_MEDIA_PUBLISH_MESSAGE
    );
  });

  it('allows and does not log when the store answered PRESENT', async () => {
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      url: KEY,
      probe: async () => MediaPresence.Present,
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'present' });
    expect(onUnknown).not.toHaveBeenCalled();
  });

  it('allows and logs when the store ANSWERED unknown', async () => {
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      url: KEY,
      probe: async () => MediaPresence.Unknown,
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'unknown' });
    expect(onUnknown).toHaveBeenCalledTimes(1);
    // 🔴 The reason is what makes the two unknown causes distinguishable. The probe RETURNED a
    // verdict rather than failing, so there is no error and the reason must say why.
    expect(onUnknown).toHaveBeenCalledWith({ reason: 'store-inconclusive', error: undefined });
  });

  it('allows and logs the error when the probe THREW', async () => {
    // The fail-open case. Inability to consult the store is not evidence of loss, and rejecting on
    // it would let a storage blip block moderation on the queue whose job is unblocking content.
    const boom = new Error('credentials not configured');
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      url: KEY,
      probe: async () => {
        throw boom;
      },
      onUnknown,
    });
    expect(decision).toEqual({ allow: true, presence: 'unknown' });
    expect(onUnknown).toHaveBeenCalledWith({ reason: 'probe-threw', error: boom });
  });

  it('allows when the probe throws SYNCHRONOUSLY, e.g. a storage client that cannot be built', async () => {
    // `getB2ImageS3Client()` throws on construction when credentials are absent, and the main app's
    // probe builds it inline. A try that only covered the await would let that escape as a 500 on a
    // publish that should have been allowed.
    const onUnknown = vi.fn();
    const decision = await assertMediaPresentForPublish({
      url: KEY,
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
      assertMediaPresentForPublish({ url: KEY, probe: async () => MediaPresence.Absent, raise })
    ).rejects.toThrow(Trpcish);
    expect(raise).toHaveBeenCalledWith(MISSING_MEDIA_PUBLISH_MESSAGE);
  });

  it('still refuses when a supplied raise returns instead of throwing', async () => {
    // The backstop. A `raise` that merely returns would otherwise fall through and publish the
    // broken image — the exact defect this module exists to remove.
    const raise = vi.fn(() => undefined);
    await expect(
      assertMediaPresentForPublish({ url: KEY, probe: async () => MediaPresence.Absent, raise })
    ).rejects.toThrow(MissingMediaError);
    expect(raise).toHaveBeenCalledTimes(1);
  });

  it('never calls raise on a verdict that allows', async () => {
    const raise = vi.fn(() => {
      throw new Error('should not be reached');
    });
    for (const presence of [MediaPresence.Present, MediaPresence.Unknown]) {
      await expect(
        assertMediaPresentForPublish({ url: KEY, probe: async () => presence, raise })
      ).resolves.toMatchObject({ allow: true });
    }
    expect(raise).not.toHaveBeenCalled();
  });
});

describe('assertMediaPresentForPublish — refusal is observable', () => {
  it('reports every refusal, so a fail-CLOSED misconfiguration cannot hide', () => {
    // The mirror of the unknown-logging case: a wrong bucket name 404s for every key, which reads
    // as `absent` for every image. Without this hook that is indistinguishable from a clean run.
    const onRefused = vi.fn();
    return expect(
      assertMediaPresentForPublish({ url: KEY, probe: async () => MediaPresence.Absent, onRefused })
    )
      .rejects.toThrow(MissingMediaError)
      .then(() => {
        expect(onRefused).toHaveBeenCalledTimes(1);
        // Carries WHICH refusal: a bucket can cause `absent` and can never cause `unrenderable`,
        // so a fail-CLOSED misconfiguration is only legible if the two are counted apart.
        expect(onRefused).toHaveBeenCalledWith('absent');
      });
  });

  it('never reports a refusal on a verdict that allows', async () => {
    const onRefused = vi.fn();
    for (const presence of [MediaPresence.Present, MediaPresence.Unknown]) {
      await assertMediaPresentForPublish({ url: KEY, probe: async () => presence, onRefused });
    }
    expect(onRefused).not.toHaveBeenCalled();
  });
});

/**
 * The classification now lives INSIDE `assertMediaPresentForPublish`, not in each runtime's probe.
 * That is the whole point of the consolidation: a runtime cannot supply its own idea of what a key
 * is, because it never gets to decide whether the probe runs.
 */
describe('assertMediaPresentForPublish — the url decides whether a probe happens at all', () => {
  it('never asks the store about a url that is not a key, and does not call it unknown', async () => {
    const probe = vi.fn(async () => MediaPresence.Absent);
    const onUnknown = vi.fn();
    const onSkipped = vi.fn();

    const decision = await assertMediaPresentForPublish({
      url: 'https://cdn.discordapp.com/avatars/123/abc.png',
      probe,
      onUnknown,
      onSkipped,
    });

    // 🔴 The probe is rigged to answer ABSENT. If the short-circuit were removed this would refuse,
    // so the case cannot pass by the probe happening to be harmless.
    expect(decision).toEqual({ allow: true, presence: 'not-applicable' });
    expect(probe).not.toHaveBeenCalled();
    // The finding this fixes: folding `not-applicable` into `unknown` made a store outage and a
    // profile-picture url emit the same line, so the count could not answer its own question.
    expect(onUnknown).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledTimes(1);
  });

  it('hands the probe the key itself, so the runtime cannot re-derive it', async () => {
    const probe = vi.fn(async () => MediaPresence.Present);
    await assertMediaPresentForPublish({ url: KEY, probe });
    expect(probe).toHaveBeenCalledWith(KEY);
  });

  it('REFUSES a blob: url without consulting the store', async () => {
    /**
     * The behaviour change. A `blob:` handle is passed through verbatim by both renderers, so a
     * published row emits `<img src="blob:…">` into someone else's browser and resolves to nothing.
     * The previous rule allowed these on the stated grounds that they "render perfectly well".
     */
    const probe = vi.fn(async () => MediaPresence.Present);
    const onRefused = vi.fn();

    await expect(
      assertMediaPresentForPublish({
        url: 'blob:https://civitai.com/0f8fad5b-d9cb-469f-a165-70867728950e',
        probe,
        onRefused,
      })
    ).rejects.toThrow(UNRENDERABLE_MEDIA_PUBLISH_MESSAGE);

    // Rigged to answer PRESENT: the refusal cannot be coming from the store.
    expect(probe).not.toHaveBeenCalled();
    expect(onRefused).toHaveBeenCalledWith('unrenderable');
  });

  it('still allows http(s), which really does render', async () => {
    // The line between the two: `getEdgeUrl` passes `http`/`blob` through verbatim, and only one of
    // those two is a live handle. Refusing http rows would break the legacy-avatar population.
    const probe = vi.fn(async () => MediaPresence.Absent);
    const decision = await assertMediaPresentForPublish({
      url: 'https://avatars.githubusercontent.com/u/12345',
      probe,
    });
    expect(decision).toEqual({ allow: true, presence: 'not-applicable' });
  });

  it('leaves data: fail-open, deliberately', async () => {
    // Probably broken too — it is NOT in either renderer's passthrough set — but "probably" is not
    // enough to justify a permanent refusal, so it is classified, not enforced.
    const decision = await assertMediaPresentForPublish({
      url: 'data:image/png;base64,AAAA',
      probe: async () => MediaPresence.Absent,
    });
    expect(decision).toEqual({ allow: true, presence: 'not-applicable' });
  });

  it('allows a null/absent url rather than failing the moderation path', async () => {
    for (const url of [null, undefined, '']) {
      await expect(
        assertMediaPresentForPublish({ url, probe: async () => MediaPresence.Absent })
      ).resolves.toEqual({ allow: true, presence: 'not-applicable' });
    }
  });
});

describe('isUnrenderableMediaUrl', () => {
  it('matches a blob: handle, case-insensitively', () => {
    expect(isUnrenderableMediaUrl('blob:https://civitai.com/abc')).toBe(true);
    expect(isUnrenderableMediaUrl('BLOB:https://civitai.com/abc')).toBe(true);
  });

  it('is anchored, so a key that merely CONTAINS the word is not swept in', () => {
    expect(isUnrenderableMediaUrl('my-blob:thing')).toBe(false);
    expect(isUnrenderableMediaUrl('blobfish.png')).toBe(false);
  });

  it('does not claim anything else is unrenderable', () => {
    for (const url of [
      'https://example.com/x.png',
      'data:image/png;base64,AAAA',
      '0f8fad5b-d9cb-469f-a165-70867728950e',
      '',
      null,
      undefined,
    ]) {
      expect(isUnrenderableMediaUrl(url)).toBe(false);
    }
  });
});

describe('summarizeProbeError', () => {
  /**
   * A `StorageClientError` embeds the remote response BODY in its message — an HTML error page or
   * an XML fault document, i.e. unbounded third-party text. Logging it raw puts that straight into
   * stdout and therefore Loki, once per inconclusive probe.
   */
  it('bounds an oversized message and SAYS it clipped it', () => {
    const body = 'x'.repeat(10_000);
    const out = summarizeProbeError(new Error(body));
    expect(out.length).toBeLessThan(MEDIA_PROBE_ERROR_MAX_LENGTH + 20);
    expect(out.endsWith('…[truncated]')).toBe(true);
    // The marker matters: a silently clipped body reads as a complete, different error.
    expect(out.startsWith('x'.repeat(MEDIA_PROBE_ERROR_MAX_LENGTH))).toBe(true);
  });

  it('leaves a short message intact and unmarked', () => {
    expect(summarizeProbeError(new Error('credentials not configured'))).toBe(
      'credentials not configured'
    );
  });

  it('flattens newlines, so one probe cannot become many log lines', () => {
    expect(summarizeProbeError(new Error('<html>\n  <body>oops</body>\n</html>'))).toBe(
      '<html> <body>oops</body> </html>'
    );
  });

  it('handles a non-Error and an absent error without throwing', () => {
    expect(summarizeProbeError('plain string')).toBe('plain string');
    expect(summarizeProbeError(undefined)).toBe('');
    expect(summarizeProbeError(null)).toBe('');
  });
});
