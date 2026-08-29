import { describe, expect, it, vi } from 'vitest';
import {
  assertMediaPresentForPublish,
  decideMediaPublish,
  IMAGE_SCAN_FAILURE_CLASS_PERMANENT,
  MEDIA_PROBE_ERROR_MAX_LENGTH,
  MediaPresence,
  MISSING_MEDIA_PUBLISH_MESSAGE,
  MissingMediaError,
  summarizeProbeError,
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
  it('refuses exactly one of the four verdicts', () => {
    expect(decideMediaPublish('absent')).toEqual({
      allow: false,
      presence: 'absent',
      message: MISSING_MEDIA_PUBLISH_MESSAGE,
    });
    expect(decideMediaPublish('present')).toEqual({ allow: true, presence: 'present' });
    expect(decideMediaPublish('unknown')).toEqual({ allow: true, presence: 'unknown' });
    expect(decideMediaPublish('not-applicable')).toEqual({
      allow: true,
      presence: 'not-applicable',
    });
  });

  it('names the four verdicts with the strings the storage layers speak', () => {
    // Pinned as literals: the probes in both runtimes build these strings from their own client's
    // answer, so renaming a member here without updating them would silently make every probe
    // return an unrecognised value that falls through to "allow".
    expect(MediaPresence.Present).toBe('present');
    expect(MediaPresence.Absent).toBe('absent');
    expect(MediaPresence.Unknown).toBe('unknown');
    expect(MediaPresence.NotApplicable).toBe('not-applicable');
  });

  it('exports the stored scan-failure class the review queue partitions on', () => {
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
 * The classification lives INSIDE `assertMediaPresentForPublish`, not in each runtime's probe. That
 * is the whole point of the consolidation: a runtime cannot supply its own idea of what a key is,
 * because it never gets to decide whether the probe runs.
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
    // Folding `not-applicable` into `unknown` would make a store outage and a profile-picture url
    // emit the same line, so the count could not answer its own question.
    expect(onUnknown).not.toHaveBeenCalled();
    expect(onSkipped).toHaveBeenCalledTimes(1);
  });

  it('will not let a STORE answer with a verdict only the url can produce', async () => {
    /**
     * 🔴 A TYPE-LEVEL guard, and it is the only kind that can hold this one — there is no runtime
     * behaviour to assert, because the point is that the call never compiles.
     *
     * `probe` is typed `MediaProbeAnswer` (present | absent | unknown), not the full four-valued
     * `MediaPresence`. Widening it back would let a store return `not-applicable`, which defeats
     * `onSkipped` — whose whole job is counting the short-circuit that happens BEFORE any store is
     * consulted.
     *
     * This file sits under a workspace package's `src`, which tsconfig INCLUDES — the exclusion for
     * `__tests__` is scoped to the ROOT `src` tree only — so `pnpm typecheck` reads these lines. If
     * the type widened, the suppression would be unused and TS2578 fails the run. The assertion IS
     * the `@ts-expect-error`.
     */
    await assertMediaPresentForPublish({
      url: KEY,
      // @ts-expect-error a probe must not be able to answer `not-applicable`
      probe: async () => MediaPresence.NotApplicable,
    });
  });

  it('hands the probe the key itself, so the runtime cannot re-derive it', async () => {
    const probe = vi.fn(async () => MediaPresence.Present);
    await assertMediaPresentForPublish({ url: KEY, probe });
    expect(probe).toHaveBeenCalledWith(KEY);
  });

  it('leaves every non-key url fail-open, deliberately', async () => {
    /**
     * The direction is chosen from what each error COSTS. A false NEGATIVE (a real key we decline to
     * probe) costs a detection; a false POSITIVE (a non-key we probe) costs a 404 that is
     * indistinguishable from a genuine miss and becomes a PERMANENT, un-overridable refusal to
     * publish an image that may render fine. `blob:` and `data:` rows are probably broken too, but
     * "probably" is inference, and inference is not enough to justify a permanent refusal.
     */
    for (const url of [
      'https://avatars.githubusercontent.com/u/12345',
      'blob:https://civitai.com/0f8fad5b-d9cb-469f-a165-70867728950e',
      'data:image/png;base64,AAAA',
    ]) {
      const probe = vi.fn(async () => MediaPresence.Absent);
      // Rigged ABSENT: if the probe ran, this would refuse.
      await expect(assertMediaPresentForPublish({ url, probe })).resolves.toEqual({
        allow: true,
        presence: 'not-applicable',
      });
      expect(probe, url).not.toHaveBeenCalled();
    }
  });

  it('allows a null/absent url rather than failing the moderation path', async () => {
    for (const url of [null, undefined, '']) {
      await expect(
        assertMediaPresentForPublish({ url, probe: async () => MediaPresence.Absent })
      ).resolves.toEqual({ allow: true, presence: 'not-applicable' });
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
