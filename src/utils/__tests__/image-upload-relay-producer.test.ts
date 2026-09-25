import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
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
    // becomes a label. The empty array is the degenerate case — `input[0]` is `undefined`,
    // which the `typeof` check catches.
    expect(sanitizeImageUploadRelayProducer(['chrome-extension://evil', 'multipart'])).toBe(
      'unknown'
    );
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

  it('pins the LABEL set — which is not the caller set; see the ledger below', () => {
    // ⚠ SCOPED DELIBERATELY, because an earlier version of this comment claimed more than
    // the assertion delivers. This pins the three LABEL values. It says nothing about how
    // many CALLERS exist: `postImageUploadRelay`'s `producer` parameter is typed to this
    // union, so a third call site is forced to reuse an existing label and compiles clean
    // — leaving this green while its traffic corrupts an already-attributed series, which
    // is worse than the `unknown` pooling the old wording described. The caller side is
    // pinned by the source ledger in the next block; keep the two claims separate.
    //
    // It is still worth pinning: `passes every declared producer through unchanged` above
    // iterates this tuple, so it would go vacuous if the tuple were shrunk to one member.
    expect([...IMAGE_UPLOAD_RELAY_PRODUCERS].sort()).toEqual(
      ['multipart', 'single_put', 'unknown'].sort()
    );
  });
});

describe('the relay caller ledger', () => {
  /**
   * 🔴 THE SEAM NOBODY ELSE OWNS: the set of code paths that can reach the relay.
   *
   * Every other guard in this change is about one component — the sanitiser bounds a
   * value, the metrics module bounds a series, each hook sends its own header. None of
   * them can see a THIRD caller appearing, and a third caller is exactly how this
   * change's own defect comes back: it would have to reuse `single_put` or `multipart`
   * to compile, and its traffic would then be added to a series someone is already
   * grading. `no-unledgered-settle-caller.test.ts` guards the same two-caller shape and
   * is the precedent for doing it this way.
   *
   * Asserted as an exact set so it fails when the caller list GROWS or SHRINKS, and on
   * the producer literal each site passes so two callers cannot quietly share one label.
   */
  const RELAY_CALLER_LEDGER: Record<string, string> = {
    'src/hooks/useCFImageUpload.tsx': 'single_put',
    'src/utils/upload-settlement.ts': 'multipart',
  };

  function sourceFiles(dir: string): string[] {
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
        out.push(...sourceFiles(full));
      } else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  const SRC = join(process.cwd(), 'src');

  it('finds EVERY relay caller in the ledger, and no caller outside it', () => {
    const callers: Record<string, string[]> = {};
    for (const file of sourceFiles(SRC)) {
      const text = readFileSync(file, 'utf8');
      const rel = relative(process.cwd(), file);
      // Two ways to reach the route: through the shared helper, or by building a request
      // against the path directly. The second is what the helper exists to prevent, so it
      // has to be part of what this ledger looks for — a bare `fetch` to the path would
      // otherwise be invisible to every guard in this change.
      const viaHelper = [...text.matchAll(/postImageUploadRelay\(\s*\w+\s*,\s*\{([^}]*)\}/g)];
      const viaPath = text.includes(`'/api/v1/image-upload/relay'`);
      if (!viaHelper.length && !viaPath) continue;
      // The definition site itself holds the literal and is a legitimate match; it is in
      // the ledger under the caller it also hosts (`relayImageFallback`).
      const producers = viaHelper
        .map((m) => /producer:\s*'([^']+)'/.exec(m[1])?.[1])
        .filter((p): p is string => Boolean(p));
      callers[rel] = producers;
    }

    expect(Object.keys(callers).sort()).toEqual(Object.keys(RELAY_CALLER_LEDGER).sort());
    for (const [file, expected] of Object.entries(RELAY_CALLER_LEDGER)) {
      expect(callers[file], `${file} must pass producer: '${expected}'`).toEqual([expected]);
    }
    // And no two callers share a label — the failure the type system cannot express.
    const labels = Object.values(RELAY_CALLER_LEDGER);
    expect(new Set(labels).size, 'two callers share one producer label').toBe(labels.length);
  });

  it('POSITIVE CONTROL: the scan reaches real files and can see a caller', () => {
    // 🔴 Without this, a scan pointed at the wrong directory, or a regex that matches
    // nothing, returns an empty caller set — and an empty set compared against an empty
    // set is the reassuring zero this whole change exists to stop believing. The ledger
    // above is only meaningful if the scanner demonstrably finds something.
    const files = sourceFiles(SRC);
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((f) => f.endsWith(join('src', 'hooks', 'useCFImageUpload.tsx'))),
      'the scan must reach the known single-PUT caller'
    ).toBe(true);
  });
});
