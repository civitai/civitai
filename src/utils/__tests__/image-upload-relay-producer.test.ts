import { describe, expect, it } from 'vitest';
import {
  IMAGE_UPLOAD_RELAY_PRODUCER_HEADER,
  IMAGE_UPLOAD_RELAY_PRODUCERS,
  UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER,
  sanitizeImageUploadRelayProducer,
} from '~/utils/image-upload-relay-producer';

/**
 * The producer discriminator's sanitiser.
 *
 * 🔴 WHAT IS AT STAKE. The value this function returns becomes a Prometheus LABEL VALUE on
 * `civitai_image_upload_relay_total`, and its input is a request header on a route that
 * takes a raw body. prom-client retains every distinct label set in the Node heap for the
 * life of the process, so a pass-through would hand any caller an unbounded series
 * generator. The bound is this function; everything else is types, which are erased.
 *
 * These are NEW-FEATURE tests — the module did not exist before this change, so there is
 * no revision at which they could be shown red against a defect. The mutation results are
 * recorded in the PR body instead: each case below was verified to fail against a
 * deliberately broken sanitiser.
 */
describe('sanitizeImageUploadRelayProducer', () => {
  it('passes every declared producer through unchanged', () => {
    // The positive control. Without it, a sanitiser that returned `unknown`
    // unconditionally would satisfy every other case in this file — and would silently
    // erase the whole discriminator while leaving the counter looking healthy.
    for (const producer of IMAGE_UPLOAD_RELAY_PRODUCERS) {
      expect(sanitizeImageUploadRelayProducer(producer), producer).toBe(producer);
    }
  });

  it('maps an ABSENT header to unknown rather than to undefined', () => {
    // 🔴 The rollout case, and the one that must not be a gap: a browser on a bundle
    // older than this change sends no header at all, and that will be MOST relay traffic
    // for a while. `undefined` would let the label be omitted, which in Prometheus is a
    // different series — the opposite of a closed set.
    expect(sanitizeImageUploadRelayProducer(undefined)).toBe('unknown');
    expect(sanitizeImageUploadRelayProducer(null)).toBe('unknown');
  });

  it('maps an unrecognised value to unknown', () => {
    // Near-misses, not obvious junk: a sanitiser built from a prefix/substring test
    // rather than set membership passes `single_put_`, `multi`, and the wrong case.
    for (const bad of [
      'single_put_',
      'single-put',
      'multi',
      'MULTIPART',
      ' multipart',
      'multipart ',
      '',
      'relay',
    ]) {
      expect(sanitizeImageUploadRelayProducer(bad), JSON.stringify(bad)).toBe('unknown');
    }
  });

  it('maps a non-string to unknown', () => {
    for (const bad of [0, 1, true, false, {}, [], () => 'multipart', Symbol('multipart')]) {
      expect(sanitizeImageUploadRelayProducer(bad), String(bad)).toBe('unknown');
    }
  });

  it('maps a REPEATED header (Node hands back an array) to unknown', () => {
    // Ambiguous provenance: two callers, or one caller trying to confuse the parse. Not
    // trusted, and specifically not by reading element [0] — that would let a crafted
    // request pick which value the server believes.
    expect(sanitizeImageUploadRelayProducer(['multipart', 'single_put'])).toBe('unknown');
    expect(sanitizeImageUploadRelayProducer(['multipart'])).toBe('unknown');
  });

  it('cannot be walked through a prototype key', () => {
    // 🔴 The reason the membership test is a Set and not an object literal. Every string
    // here answers truthy to `{}[key]`, so an object-backed lookup would emit them as
    // label values — `__proto__` especially, since it also exists on any JSON body a
    // caller controls.
    for (const bad of [
      '__proto__',
      'constructor',
      'prototype',
      'toString',
      'hasOwnProperty',
      'valueOf',
    ]) {
      expect(sanitizeImageUploadRelayProducer(bad), bad).toBe('unknown');
    }
  });

  it('cannot produce a value outside the declared set, for any input', () => {
    // 🔴 THE PROPERTY, stated as a property rather than as a list of cases. A label-value
    // injection is precisely "the output was not a member", so this is the assertion that
    // survives someone adding a producer, and the one a crafted input has to beat.
    const injections: unknown[] = [
      'multipart"} 999999\ncivitai_image_upload_relay_total{outcome="success',
      'multipart\\',
      'multipart\n',
      'multipart"',
      '{producer="multipart"}',
      'single_put,multipart',
      'a'.repeat(4096),
      { toString: () => 'multipart' },
      new String('multipart'), // eslint-disable-line no-new-wrappers
    ];
    for (const input of injections) {
      const out = sanitizeImageUploadRelayProducer(input);
      expect(
        (IMAGE_UPLOAD_RELAY_PRODUCERS as readonly string[]).includes(out),
        `input=${String(input)} produced ${out}`
      ).toBe(true);
      // And specifically: none of the crafted inputs is allowed to READ as a real
      // producer. `new String('multipart')` is the interesting one — it is not a
      // primitive string, so a `typeof` check must reject it rather than an `instanceof`
      // one accepting it.
      expect(out, `input=${String(input)}`).toBe(UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER);
    }
  });
});

describe('the producer contract itself', () => {
  it('pins the wire name of the header', () => {
    // The one place the literal is written down in a test. Every other site — both
    // callers and the route — reads the constant, so a rename stays consistent by
    // construction and this makes it DELIBERATE rather than silent. A rename is not a
    // free refactor: it splits the signal at the deploy boundary, since browsers running
    // the old bundle keep sending the old name and land in `unknown`.
    expect(IMAGE_UPLOAD_RELAY_PRODUCER_HEADER).toBe('x-civitai-upload-producer');
  });

  it('keeps the header name lowercase so it can index req.headers directly', () => {
    // Node lowercases every incoming header name. A constant with any uppercase letter
    // would read `req.headers['X-...']` as undefined — i.e. EVERY request would bucket as
    // `unknown` and the discriminator would be inert while looking perfectly healthy.
    expect(IMAGE_UPLOAD_RELAY_PRODUCER_HEADER).toBe(
      IMAGE_UPLOAD_RELAY_PRODUCER_HEADER.toLowerCase()
    );
  });

  it('declares unknown as a member of the set, not as a value outside it', () => {
    // The seeding loop in the metrics module iterates this tuple, so `unknown` being a
    // member is what makes its series exist at 0 on a pod where nothing has relayed.
    expect(IMAGE_UPLOAD_RELAY_PRODUCERS).toContain(UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER);
  });

  it('declares one producer per relay caller, and names them', () => {
    // 🔴 A LEDGER, not a count. The relay has exactly two callers — the single-PUT path
    // (`useCFImageUpload`) and the multipart path (`useS3Upload` via
    // `relayImageFallback`) — plus the `unknown` bucket. A third caller added without a
    // label of its own would silently pool into `unknown` and be unattributable, which is
    // the defect this whole change fixes; this fails when the set grows OR shrinks.
    expect([...IMAGE_UPLOAD_RELAY_PRODUCERS].sort()).toEqual(
      ['multipart', 'single_put', 'unknown'].sort()
    );
  });
});
