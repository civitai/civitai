import { describe, expect, it } from 'vitest';
import {
  IMAGE_UPLOAD_RELAY_PRODUCER_HEADER,
  IMAGE_UPLOAD_RELAY_PRODUCERS,
  OTHER_IMAGE_UPLOAD_RELAY_PRODUCER,
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

  it('🔴 maps an unrecognised value to `other`, NOT to `unknown`', () => {
    // 🔴 THE SPLIT, and it is this change's own thesis applied to itself. `unknown` means
    // "no header at all" — the stale-bundle population, and the row a rollout is graded
    // on. A header that ARRIVED and was not recognised is a different fact with different
    // causes (a client that got it wrong, a caller probing the route), and folding the two
    // puts two populations behind one number.
    //
    // ⚠ These used to assert `unknown`. The fold was defended as "the second population is
    // negligible, split it later if that stops holding" — but nothing could ever reveal
    // that it had: the raw value is discarded, and the only event carrying a producer is
    // success-only and carries the sanitised one. An unobservable trigger is not a
    // deferral.
    //
    // Near-misses, not obvious junk: a sanitiser built from a prefix/substring test rather
    // than set membership passes `single_put_`, `multi`, and the wrong case.
    for (const bad of [
      'single_put_',
      'single-put',
      'multi',
      'MULTIPART',
      ' multipart',
      'multipart ',
      'relay',
      // 🔴 The empty string is HERE, not with the absent cases. It is a header that
      // ARRIVED carrying nothing — a client computing a bad value, not a client too old to
      // send one — and `boundedClientLabel`, the sibling this module follows, agrees.
      '',
    ]) {
      expect(sanitizeImageUploadRelayProducer(bad), JSON.stringify(bad)).toBe('other');
    }
  });

  it('maps a non-string to unknown — nothing usable arrived', () => {
    for (const bad of [0, 1, true, false, {}, [], () => 'multipart', Symbol('multipart')]) {
      expect(sanitizeImageUploadRelayProducer(bad), String(bad)).toBe('unknown');
    }
  });

  it('takes the FIRST value of a repeated header, matching the sibling label narrowers', () => {
    // Node hands back an array when a header arrives more than once in a way it cannot
    // join. `firstValue`/`boundedClientLabel` in `src/server/prom/trpc-batch.metrics.ts`
    // already settled this for the same class of input — a caller-supplied header narrowed
    // to a bounded Prometheus label — and two normalisers in `src/pages/api/internal/`
    // agree with it. ⚠ An earlier draft returned `unknown` for any array; that diverged
    // from all three, and in the direction that demotes a legitimate rescue into the row
    // the rollout is graded on.
    expect(sanitizeImageUploadRelayProducer(['multipart', 'single_put'])).toBe('multipart');
    expect(sanitizeImageUploadRelayProducer(['multipart'])).toBe('multipart');
  });

  it('still bounds an array whose first element is crafted, and an empty one', () => {
    // 🔴 Why taking [0] costs no safety: the closed-set test runs on the element taken, so
    // element order decides WHICH member is believed, never WHETHER an arbitrary string
    // becomes a label. The empty ARRAY is the degenerate case — `input[0]` is `undefined`,
    // so nothing arrived and it is `unknown`; contrast the empty STRING, which arrived and
    // is `other`.
    expect(sanitizeImageUploadRelayProducer(['chrome-extension://evil', 'multipart'])).toBe(
      'other'
    );
    // An empty array and a nested one are "nothing usable arrived", so they are `unknown`
    // rather than `other` — the same distinction the two buckets carry everywhere else.
    expect(sanitizeImageUploadRelayProducer([])).toBe('unknown');
    expect(sanitizeImageUploadRelayProducer([['multipart']])).toBe('unknown');
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
      expect(sanitizeImageUploadRelayProducer(bad), bad).toBe('other');
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
      // producer. They land in one of the two rejection buckets — a string one in `other`,
      // and `new String('multipart')` in `unknown`, which is the interesting case: it is
      // not a primitive string, so a `typeof` check must reject it rather than an
      // `instanceof` one accepting it.
      expect(
        [UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER, OTHER_IMAGE_UPLOAD_RELAY_PRODUCER],
        `input=${String(input)}`
      ).toContain(out);
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

  it('declares both rejection buckets as members of the set, not as values outside it', () => {
    // The seeding loop in the metrics module iterates this tuple, so membership is what
    // makes each series exist at 0 on a pod where nothing has relayed.
    expect(IMAGE_UPLOAD_RELAY_PRODUCERS).toContain(UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER);
    expect(IMAGE_UPLOAD_RELAY_PRODUCERS).toContain(OTHER_IMAGE_UPLOAD_RELAY_PRODUCER);
    // And they are DISTINCT — the whole point of the split.
    expect(UNKNOWN_IMAGE_UPLOAD_RELAY_PRODUCER).not.toBe(OTHER_IMAGE_UPLOAD_RELAY_PRODUCER);
  });

  it('pins the LABEL set — which is not the caller set; see the ledger in its own file', () => {
    // ⚠ SCOPED DELIBERATELY, because an earlier version of this comment claimed more than
    // the assertion delivers. This pins the four LABEL values. It says nothing about how
    // many CALLERS exist: `postImageUploadRelay`'s `producer` parameter is typed to this
    // union, so a third call site is forced to reuse an existing label and compiles clean
    // — leaving this green while its traffic corrupts an already-attributed series, which
    // is worse than the `unknown` pooling the old wording described. The caller side is
    // pinned by `src/utils/__tests__/relay-caller-ledger.test.ts`, which walks the AST
    // rather than the text; keep the two claims separate.
    //
    // It is still worth pinning: `passes every declared producer through unchanged` above
    // iterates this tuple, so it would go vacuous if the tuple were shrunk to one member.
    expect([...IMAGE_UPLOAD_RELAY_PRODUCERS].sort()).toEqual(
      ['multipart', 'other', 'single_put', 'unknown'].sort()
    );
  });
});
