import { describe, it, expect, beforeEach } from 'vitest';
import client from 'prom-client';
import {
  IMAGE_UPLOAD_RELAY_METRIC,
  IMAGE_UPLOAD_RELAY_OUTCOMES,
  ensureRegisterImageUploadRelayMetrics,
  isImageUploadRelayOutcome,
  recordImageUploadRelay,
  __resetImageUploadRelayMetricsForTest,
  type ImageUploadRelayOutcome,
} from '~/server/prom/image-upload-relay.metrics';
import { IMAGE_UPLOAD_RELAY_PRODUCERS } from '~/utils/image-upload-relay-producer';

// Pure unit test: this module imports only prom-client (no env / Prisma / DB), so
// nothing here boots the app graph. Values are read back off the default registry —
// the same registry `/api/metrics` serves — rather than off the counter object the
// module happens to hold, so a counter registered on the WRONG registry fails here
// instead of passing on an in-memory handle nothing scrapes.

type MetricJSON = { values: { value: number; labels: Record<string, string> }[] };

/**
 * Counts keyed by OUTCOME, summed across producers.
 *
 * ⚠ The summing is deliberate and it is a LOSS: this view cannot see a wrong producer
 * label. It exists so the outcome-level cases below keep asserting the outcome claim they
 * were written for. Anything about the producer must read `seriesByLabels` instead.
 */
async function seriesFromRegistry(): Promise<Record<string, number>> {
  const byLabels = await seriesByLabels();
  const out: Record<string, number> = {};
  for (const { outcome, value } of byLabels) out[outcome] = (out[outcome] ?? 0) + value;
  return out;
}

/** Every child series, both labels intact. */
async function seriesByLabels(): Promise<{ outcome: string; producer: string; value: number }[]> {
  const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as
    | { get: () => Promise<MetricJSON> }
    | undefined;
  if (!metric) return [];
  const data = await metric.get();
  return data.values.map((v) => ({
    outcome: v.labels.outcome,
    producer: v.labels.producer,
    value: v.value,
  }));
}

/** The counts for one producer, keyed by outcome. */
async function seriesForProducer(producer: string): Promise<Record<string, number>> {
  const rows = await seriesByLabels();
  return Object.fromEntries(
    rows.filter((r) => r.producer === producer).map((r) => [r.outcome, r.value])
  );
}

beforeEach(() => {
  __resetImageUploadRelayMetricsForTest();
});

describe('civitai_image_upload_relay_total registration', () => {
  it('registers on the DEFAULT registry, which is the one /api/metrics scrapes', async () => {
    ensureRegisterImageUploadRelayMetrics();
    // Not "the function returned a counter" — a counter on a private registry would
    // satisfy that and be scraped by nothing.
    expect(client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC)).toBeDefined();
    expect(await seriesFromRegistry()).toHaveProperty('success');
  });

  it('SEEDS every outcome at 0 so an absent series cannot be mistaken for a real zero', async () => {
    // 🔴 The point of the whole module. The relay fires a handful of times across the
    // fleet, so on nearly every pod the true reading is all-zeros — and prom-client
    // materialises a child only on its first inc(). Without seeding, PromQL returns
    // `no data`, indistinguishable from "never deployed".
    ensureRegisterImageUploadRelayMetrics();
    const series = await seriesFromRegistry();
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(series[outcome], `outcome=${outcome} must be seeded`).toBe(0);
    }
    // And nothing beyond the declared union — a stray series is a cardinality leak.
    expect(Object.keys(series).sort()).toEqual([...IMAGE_UPLOAD_RELAY_OUTCOMES].sort());
  });

  it('🔴 SEEDS THE FULL CROSS PRODUCT — every outcome x every producer, at 0', async () => {
    // 🔴 THE PROPERTY THE PRODUCER LABEL COULD HAVE BROKEN. Seeding the outcomes alone
    // (each under one default producer) leaves
    // `…{outcome="success",producer="multipart"}` ABSENT until the multipart path's first
    // real rescue — so PromQL answers `no data`, which is indistinguishable from "that
    // caller is not wired up". That is the same ambiguity the seeding exists to remove,
    // reintroduced one level down, on exactly the question the label was added to settle.
    //
    // Enumerated as a cross product rather than as a count, so the case cannot be
    // satisfied by the right NUMBER of series carrying the wrong LABELS.
    ensureRegisterImageUploadRelayMetrics();
    const rows = await seriesByLabels();
    const seen = new Set(rows.map((r) => `${r.outcome}|${r.producer}`));
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      for (const producer of IMAGE_UPLOAD_RELAY_PRODUCERS) {
        expect(seen.has(`${outcome}|${producer}`), `${outcome}|${producer} must be seeded`).toBe(
          true
        );
      }
    }
    // Exactly the cross product: no more (a leak) and no fewer (a gap).
    expect(rows).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    expect(rows.every((r) => r.value === 0)).toBe(true);
  });

  it('seeds `unknown` like any other producer — it is the ROLLOUT reading, not a gap', async () => {
    // 🔴 Called out separately from the cross-product case because it is the series that
    // will carry nearly all the traffic immediately after this ships: a browser on an
    // older cached bundle sends no header. If `unknown` were treated as an error bucket
    // and left unseeded, the first weeks of rollout would read as `no data` on the only
    // row that was moving.
    ensureRegisterImageUploadRelayMetrics();
    const unknownRows = (await seriesByLabels()).filter((r) => r.producer === 'unknown');
    expect(unknownRows).toHaveLength(IMAGE_UPLOAD_RELAY_OUTCOMES.length);
    expect(unknownRows.every((r) => r.value === 0)).toBe(true);
  });

  it('is idempotent: re-registering neither throws nor resets counts', async () => {
    // prom-client throws on a duplicate metric name, and Next can evaluate a module
    // twice (HMR / route bundling). It is also called on every scrape, so a seeding
    // pass that zeroed live counts would erase the evidence between scrapes.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'single_put');
    recordImageUploadRelay('success', 'single_put');
    expect(() => ensureRegisterImageUploadRelayMetrics()).not.toThrow();
    expect((await seriesFromRegistry()).success).toBe(2);
  });

  it('holds the cardinality bound at exactly two labels over two closed unions', async () => {
    // 🔴 A RELATIONSHIP, not a magic number: series-per-pod = |outcomes| x |producers|,
    // and nothing caller-supplied may widen it. Adding a third label, or one carrying a
    // user id / key / host / size, fails this — including the tempting ones, since the
    // producer header arrives on the same request as a Content-Type and a user session.
    ensureRegisterImageUploadRelayMetrics();
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      labelNames: string[];
      get: () => Promise<MetricJSON>;
    };
    expect([...metric.labelNames].sort()).toEqual(['outcome', 'producer']);
    const { values } = await metric.get();
    expect(values).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    for (const v of values) expect(Object.keys(v.labels).sort()).toEqual(['outcome', 'producer']);
  });
});

describe('the HELP string', () => {
  /** The rendered HELP text, read off the registry the scrape serves. */
  async function help(): Promise<string> {
    ensureRegisterImageUploadRelayMetrics();
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      get: () => Promise<{ help: string }>;
    };
    return (await metric.get()).help;
  }

  /**
   * 🔴 THE WHOLE STRING, PINNED — and the two weaker guards this replaced are the reason.
   *
   * HELP is the operator-facing documentation for a signal whose entire purpose is to be
   * read correctly under rollout pressure, and it is built by concatenating adjacent string
   * literals. An edit that rewrites one line and leaves the tail of the next produces a
   * sentence that is broken only once the pieces are JOINED — invisible to anyone reading
   * the source. That shipped: the fragment `inside it.` sat orphaned mid-sentence, and a
   * reviewer had to render the concatenation by hand to see it.
   *
   * ⚠ TWO WEAKER GUARDS WERE WRITTEN FIRST AND BOTH WERE VACUOUS, measured:
   *   - "every label appears in HELP" (`toContain(producer)`) — satisfied by ANY occurrence
   *     of the word, so deleting `unknown`'s definition still passed, because the sentence
   *     "read a large unknown share as stale clients" contains it.
   *   - "no sentence starts mid-thought" — the orphan is mid-sentence, not sentence-initial,
   *     so the check never looked at it. Reinstating the exact shipped defect passed.
   * Both are the same error: a guard on WORDS over an artifact that IS prose, walkable by
   * rewording. The only machine-readable claim about prose is the prose itself.
   *
   * 🔴 SO A COSMETIC REWORD FAILS THIS TEST. That is the price and it is the point — the
   * failure forces whoever edits HELP to read the RENDERED result and paste it back, which
   * is exactly the step whose absence let the orphan through. Update it by running the
   * suite and copying the actual value; do not hand-edit this constant to match.
   */
  const EXPECTED_HELP = `Invocations of the FALLBACK image-upload relay route, by terminal outcome and by the client that claims to have produced them. The relay exists for clients that cannot reach the storage host directly, so a non-zero success count is the only evidence that fallback is rescuing real uploads: a relayed 200 is not retained in the request-log stream, traces are head-sampled, and the media-location registry records the same backend for relayed and direct uploads. Exactly one increment per handler invocation. outcome: success = bytes stored and a key returned; method_not_allowed = not a POST; forbidden_origin = production cross-origin guard; unauthorized = no session or banned; busy = shed by the per-pod in-flight cap (429); too_large = over the size cap (413); truncated = body ended short of its declared Content-Length (400, never stored); empty = zero-length body (400); read_error = reading the body threw (400); store_error = the store write threw (500, or 499 on a client disconnect); handler_error = the invocation threw without naming an outcome — expected to stay 0, and a non-zero can be an upstream auth dependency failing rather than a bug in this route. producer: which client CLAIMS to have asked for the relay, sanitised server-side into a closed set — the sanitiser rejects anything that is not one of the two declarable producers (single_put, multipart) but cannot verify one that is. To corroborate, read the USER IDS on the image-upload-relayed events and check the rescues belong to a plausible population; do NOT compare against those events producer field, which is the same derivation as this label and agrees by construction. Note those events cover SUCCESSFUL relays only, so there is no corroborating event for the refusal outcomes. single_put = the single-PUT upload path; multipart = the multipart upload path; unknown = no header at all, EXPECTED to dominate while browsers still run a bundle older than the deploy that added the header, so read a large unknown share as stale clients rather than as a gap; other = a header arrived and was not recognised, which is a DIFFERENT population (a client that got it wrong, a caller probing the route, a caller declaring one of the server buckets, or — rarely — a value our own emitter failed to recognise, which is a bug on our side rather than a statement about the request) and is kept on its own row so neither hides in the other. Without this label a non-zero success count cannot be attributed to either caller. RARE per-pod counter, and prom-client counts die with the pod: for "has it ever helped?" read sum(increase(...[30d])) or sum(max_over_time(...[30d])); a bare sum() only sees pods that are alive right now. Do not alert on rate() of a single child.`;

  it('🔴 matches the pinned text EXACTLY — see the note above before updating it', async () => {
    expect(await help()).toBe(EXPECTED_HELP);
  });

  it('defines every label value a reader can filter by', async () => {
    // Weaker than the pin, and kept for its FAILURE MESSAGE: the pin says "the string
    // changed", this says WHICH label lost its definition. `%s = ` is the shape HELP uses
    // for every one ("success = bytes stored…"), so this cannot be satisfied by an
    // incidental mention of the word elsewhere in the text — which is precisely how the
    // first version of this guard passed while a definition was missing.
    const text = await help();
    for (const producer of IMAGE_UPLOAD_RELAY_PRODUCERS) {
      expect(text, `producer=${producer} must be DEFINED in HELP`).toContain(`${producer} = `);
    }
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(text, `outcome=${outcome} must be DEFINED in HELP`).toContain(`${outcome} = `);
    }
  });
});

describe('recordImageUploadRelay', () => {
  it('increments the named outcome AND ONLY that one', async () => {
    // The "and only that one" half is what a hardcoded label value fails: a mutant
    // that always writes `success` still increments something, so asserting a single
    // outcome moved would pass it.
    recordImageUploadRelay('too_large', 'single_put');
    const series = await seriesFromRegistry();
    expect(series.too_large).toBe(1);
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      if (outcome !== 'too_large') expect(series[outcome], `outcome=${outcome}`).toBe(0);
    }
  });

  it('keeps each outcome on its own series across a mixed sequence', async () => {
    // Every declared outcome is exercised at a DISTINCT count, so the assertion cannot
    // be satisfied by a constant, by a shifted mapping, or by two outcomes being
    // silently folded into one series.
    const expected = new Map<ImageUploadRelayOutcome, number>();
    IMAGE_UPLOAD_RELAY_OUTCOMES.forEach((outcome, i) => {
      const n = i + 1;
      expected.set(outcome, n);
      for (let k = 0; k < n; k++) recordImageUploadRelay(outcome, 'single_put');
    });
    const series = await seriesFromRegistry();
    for (const [outcome, n] of expected) expect(series[outcome], `outcome=${outcome}`).toBe(n);
  });

  it('DROPS an unknown outcome rather than relabelling it', async () => {
    // The cardinality bound rests on this runtime narrowing, not on the erased type.
    // 🔴 Two separate claims: no new series appears (the bound), and no EXISTING series
    // absorbs it (a fallback to `unknown` or, far worse, to `success` would invent
    // evidence that the relay rescued an upload).
    //
    // Seeded first so the assertion has a baseline to compare against: the narrowing
    // returns BEFORE registration, so without this the registry is simply empty and the
    // "no new series" check would pass vacuously against a mutant that dropped nothing.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('surprise' as unknown as ImageUploadRelayOutcome, 'single_put');
    recordImageUploadRelay('' as unknown as ImageUploadRelayOutcome, 'single_put');
    recordImageUploadRelay(undefined as unknown as ImageUploadRelayOutcome, 'single_put');
    const series = await seriesFromRegistry();
    expect(Object.keys(series).sort()).toEqual([...IMAGE_UPLOAD_RELAY_OUTCOMES].sort());
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(series[outcome], `outcome=${outcome}`).toBe(0);
    }
  });

  it('🔴 NARROWS an unrecognised producer to a bucket instead of dropping the increment', async () => {
    // 🔴 THE ASYMMETRY WITH THE CASE ABOVE, AND IT IS DELIBERATE. Both inputs are
    // code-owned by the time they reach the emitter — the route has already sanitised the
    // header — so an unrecognised value of either is our own defect. What differs is the
    // cost of dropping it: an unrecognised outcome loses nothing we could trust anyway,
    // while dropping a producer would cost the counter's load-bearing property that
    // `sum()` equals the route's invocation count, which is what makes a bare `sum()`
    // readable at all. It is bucketed instead. (This comment argued the producer must be
    // kept because the header is caller-supplied. That is the SANITISER's argument, and
    // restating it one layer downstream is a mistake this change has now made three
    // times: no caller can reach this branch.)
    //
    // Both halves are asserted: the invocation IS counted, and it is counted on the
    // `other` series rather than on an invented one — and specifically NOT on `unknown`,
    // which is a claim about the REQUEST. (This sentence said `unknown` for one round,
    // eleven lines above the assertion that requires the opposite. Two comments in one
    // block disagreeing is how a later edit "fixes" the code to match the wrong one.)
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'chrome-extension://evil' as never);
    recordImageUploadRelay('success', undefined as never);
    recordImageUploadRelay('success', '' as never);

    const rows = await seriesByLabels();
    expect(rows).toHaveLength(
      IMAGE_UPLOAD_RELAY_OUTCOMES.length * IMAGE_UPLOAD_RELAY_PRODUCERS.length
    );
    // 🔴 ALL THREE land in `other`, and the reason is a distinction this module had to
    // learn the hard way. The emitter's input is SERVER-derived — the route has already
    // sanitised the header — so a value that is not one of the four labels is OUR defect,
    // not a statement about the request. It must not land in `unknown`, which means "the
    // request carried no header" and is the row a rollout is graded on: letting our bugs
    // into it would inflate exactly the number someone reads as "stale bundles".
    expect((await seriesForProducer('other')).success).toBe(3);
    expect((await seriesForProducer('unknown')).success).toBe(0);
    // And nowhere else: a narrowing that also leaked onto a real producer would make the
    // multipart figure include traffic that never came from it.
    expect((await seriesForProducer('multipart')).success).toBe(0);
    expect((await seriesForProducer('single_put')).success).toBe(0);
    // Every invocation is still counted — three in, three recorded. Dropping one would let
    // a caller choose not to be counted.
    expect((await seriesFromRegistry()).success).toBe(3);
  });

  it('keeps producers on SEPARATE series for the same outcome', async () => {
    // 🔴 The whole point of the label, and the case that fails if the producer is
    // hardcoded, folded, or dropped from the `inc` call. The per-producer counts below are
    // all distinct and none equals the total.
    ensureRegisterImageUploadRelayMetrics();
    recordImageUploadRelay('success', 'single_put');
    recordImageUploadRelay('success', 'multipart');
    recordImageUploadRelay('success', 'multipart');
    recordImageUploadRelay('success', 'unknown');
    recordImageUploadRelay('success', 'unknown');
    recordImageUploadRelay('success', 'unknown');
    for (let i = 0; i < 4; i++) recordImageUploadRelay('success', 'other');

    // Four distinct counts on one outcome, none equal to another and none equal to the
    // total — so a constant, a shifted mapping and a fold are all visibly wrong here.
    expect((await seriesForProducer('single_put')).success).toBe(1);
    expect((await seriesForProducer('multipart')).success).toBe(2);
    expect((await seriesForProducer('unknown')).success).toBe(3);
    expect((await seriesForProducer('other')).success).toBe(4);
    // The summed view still reads as the route's invocation count — the property the
    // label must not cost us.
    expect((await seriesFromRegistry()).success).toBe(10);
  });

  it('never throws — a metrics failure must not break the upload it is observing', async () => {
    // This route runs only AFTER the user's direct upload has already failed. An
    // exception escaping the emitter would turn the rescue into the outage.
    //
    // 🔴 REGISTER FIRST, then read the handle. The handle comes off the registry, so
    // reading it before the counter exists yields `undefined` and the case dies on the
    // stub setup rather than on its own claim. Written the other way round it passed
    // only because an earlier test in this file had already registered the counter —
    // i.e. by file ordering, not by construction. Verified: run alone
    // (`-t "never throws"`) the old order failed with
    // `TypeError: Cannot read properties of undefined (reading 'inc')`.
    ensureRegisterImageUploadRelayMetrics();
    const metric = client.register.getSingleMetric(IMAGE_UPLOAD_RELAY_METRIC) as unknown as {
      inc: (labels: Record<string, string>, value?: number) => void;
    };
    const realInc = metric.inc;

    // 🔴 Throw from the FINAL increment, not from the seeding pass. A stub that throws
    // on EVERY `inc` fires on `seedAllSeries`'s first call — inside
    // `ensureRegisterImageUploadRelayMetrics()` — and never reaches
    // `imageUploadRelayTotal.inc({ outcome, producer })`, so it only proves the try/catch swallows
    // *a* throw from somewhere in the emit path. The guard's actual claim is about the
    // increment. Seeding always passes a second argument (0) and the real increment
    // never does, which is what discriminates the two call sites.
    let finalIncAttempts = 0;
    metric.inc = (labels: Record<string, string>, value?: number) => {
      if (value === undefined) {
        finalIncAttempts += 1;
        throw new Error('registry exploded');
      }
      realInc.call(metric, labels, value);
    };
    try {
      expect(() => recordImageUploadRelay('success', 'single_put')).not.toThrow();
      // Positive control: without this, a stub that was never reached at all would let
      // the case pass as "the error was swallowed" having thrown nothing.
      expect(finalIncAttempts, 'the final inc({ outcome, producer }) must have been reached').toBe(
        1
      );
    } finally {
      metric.inc = realInc;
    }
    // And the throw must not have left a phantom count behind.
    expect((await seriesFromRegistry()).success).toBe(0);
  });
});

describe('isImageUploadRelayOutcome', () => {
  it('accepts every declared outcome', () => {
    for (const outcome of IMAGE_UPLOAD_RELAY_OUTCOMES) {
      expect(isImageUploadRelayOutcome(outcome), outcome).toBe(true);
    }
  });

  it('rejects near-misses and non-strings', () => {
    // Near-misses rather than obvious junk: a guard built from a substring/prefix test
    // rather than set membership passes on `success_` and `succ`.
    for (const bad of ['success_', 'succ', 'SUCCESS', ' success', 'outcome', '', 'toString']) {
      expect(isImageUploadRelayOutcome(bad), JSON.stringify(bad)).toBe(false);
    }
    for (const bad of [undefined, null, 0, 1, {}, [], true]) {
      expect(isImageUploadRelayOutcome(bad), String(bad)).toBe(false);
    }
  });
});
