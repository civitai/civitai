import { describe, expect, it } from 'vitest';

import {
  H3_BUZZ_PER_SECOND,
  H3_DURATIONS,
  h3VideoStep,
  type H3VideoStepParams,
} from '../h3-video.step';

const BLOB = 'https://orchestration-new.civitai.com/v2/consumer/blobs/frame.png?sig=x';

function params(overrides: Partial<H3VideoStepParams> = {}): H3VideoStepParams {
  return {
    prompt: 'Two news anchors behind a blue desk.',
    firstFrame: BLOB,
    duration: 6,
    ...overrides,
  } as H3VideoStepParams;
}

describe('h3-video params', () => {
  it('accepts a first frame on an orchestrator blob host', () => {
    expect(h3VideoStep.paramSchema.safeParse(params()).success).toBe(true);
  });

  // The bound that stops a block pointing the worker at a host it chose.
  it('rejects a first frame that is not Civitai-hosted', () => {
    const res = h3VideoStep.paramSchema.safeParse(
      params({ firstFrame: 'https://evil.example/frame.png' })
    );
    expect(res.success).toBe(false);
  });

  it('rejects a duration that is not a priced variant', () => {
    expect(h3VideoStep.paramSchema.safeParse(params({ duration: 5 as never })).success).toBe(false);
    expect(h3VideoStep.paramSchema.safeParse(params({ duration: 15 as never })).success).toBe(
      false
    );
  });

  it('rejects an empty prompt', () => {
    expect(h3VideoStep.paramSchema.safeParse(params({ prompt: '' })).success).toBe(false);
  });

  // `.strict()` is what keeps the exposed surface the reviewed one: `loras` and
  // `diffusionModel` are real engine inputs and both carry AIR resources, which
  // this entry declares it has none of.
  it('rejects engine inputs this entry does not expose', () => {
    for (const extra of [{ loras: { a: 1 } }, { diffusionModel: 'urn:air:x' }, { turbo: true }]) {
      const res = h3VideoStep.paramSchema.safeParse({ ...params(), ...extra });
      expect(res.success).toBe(false);
    }
  });
});

describe('h3-video price', () => {
  // Measured by free whatif against the live orchestrator, 2026-09-21:
  // 6s quoted 210 and 4s quoted 140.
  it('prices each duration at the measured rate', () => {
    expect(h3VideoStep.priceForVariant('6')).toBe(210);
    expect(h3VideoStep.priceForVariant('4')).toBe(140);
    expect(H3_BUZZ_PER_SECOND).toBe(35);
  });

  // The block is SHOWN the estimate and CHARGED the price; the registry
  // enforces this at load, and this pins it per variant.
  it('shows an estimate equal to what it charges', () => {
    for (const duration of H3_DURATIONS) {
      expect(h3VideoStep.estimateBuzz(params({ duration }))).toBe(
        h3VideoStep.priceForVariant(String(duration))
      );
    }
  });

  it('resolves the variant from the duration', () => {
    expect(h3VideoStep.resolveVariant(params({ duration: 4 }))).toBe('4');
    expect(h3VideoStep.resolveVariant(params({ duration: 6 }))).toBe('6');
  });
});

describe('h3-video built step', () => {
  it('pins the engine, the operation and the server-fixed size', () => {
    const built = h3VideoStep.buildStep(params());
    expect(built.$type).toBe('videoGen');
    expect(built.input).toMatchObject({
      engine: 'minimax-h3-comfy',
      operation: 'imageToVideo',
      duration: 6,
      width: 1344,
      height: 768,
      firstFrame: BLOB,
    });
  });

  it('omits lastFrame when none was asked for', () => {
    expect(h3VideoStep.buildStep(params()).input).not.toHaveProperty('lastFrame');
    expect(h3VideoStep.buildStep(params({ lastFrame: BLOB })).input).toHaveProperty(
      'lastFrame',
      BLOB
    );
  });

  // No AIR reference anywhere in the built step — the property the entry's
  // `resourcePolicy: { kind: 'none' }` declares, asserted on the built value.
  it('builds a step carrying no AIR resource', () => {
    expect(JSON.stringify(h3VideoStep.buildStep(params()))).not.toContain('urn:air:');
  });

  it('hands the prompt to the audit', () => {
    expect(h3VideoStep.auditableText(params({ prompt: 'a crowd at night' }))).toEqual({
      prompt: 'a crowd at night',
    });
  });
});

describe('h3-video output', () => {
  it('extracts the video url from a real completed step', () => {
    const media = h3VideoStep.extractOutput(h3VideoStep.canonicalOutputFor('6'));
    expect(media).toHaveLength(1);
    expect(media[0].url).toContain('KHAYZ6BS0VY8QR8Z7Z8ZPXDDA0.mp4');
  });

  // An unavailable blob is a job that charged and produced nothing usable.
  // Publishing its url hands the block a link that 403s.
  it('publishes nothing for a blob that is not available', () => {
    expect(
      h3VideoStep.extractOutput({
        $type: 'videoGen',
        output: { video: { url: 'https://example.test/x.mp4', available: false } },
      })
    ).toEqual([]);
  });

  it('publishes nothing when the step has no output yet', () => {
    expect(h3VideoStep.extractOutput({ $type: 'videoGen' })).toEqual([]);
    expect(h3VideoStep.extractOutput(undefined)).toEqual([]);
  });

  // 🔴 THE KEY NAME IS THE FINDING. `videoGen` returns `output.video` while the
  // neighbouring `composeMedia` returns `output.videoBlob`; reading the wrong
  // one is an entry that charges, succeeds and publishes nothing. The generated
  // types pin it at compile time in `type-contract.ts`; this pins the
  // behaviour, against a shape captured from a real response.
  it('reads video, not videoBlob', () => {
    expect(
      h3VideoStep.extractOutput({
        $type: 'videoGen',
        output: { videoBlob: { url: 'https://example.test/wrong.mp4', available: true } },
      })
    ).toEqual([]);
  });
});
