import { describe, expect, it } from 'vitest';
import { buildAppsStoreFeedbackContext } from '~/components/Apps/appsStoreFeedbackContext';
import {
  APPS_STORE_DEFAULTS,
  resolveAppsStoreFilters,
} from '~/components/Apps/appsStoreQueryParams';
import { createFeedbackSchema } from '~/server/schema/feedback.schema';
import { FEEDBACK_FILTER_VALUE_MAX_LENGTH } from '~/shared/constants/feedback.constants';

/**
 * The triage payload the `/apps` marketplace prompt attaches to a report.
 *
 * The load-bearing case is the LAST describe block. `context.filters` bounds every
 * value at `FEEDBACK_FILTER_VALUE_MAX_LENGTH` and a zod `max()` REJECTS rather than
 * truncates, so an unclipped search term does not arrive shortened — it fails the
 * whole submission. That is why the clip is a real guard and not tidiness, and why
 * these assertions drive the built context through `createFeedbackSchema` rather
 * than merely reading the returned string's length: a length assertion alone would
 * still pass if the schema's bound moved away from the constant the builder clips to.
 */
describe('buildAppsStoreFeedbackContext', () => {
  const filters = (over: Partial<typeof APPS_STORE_DEFAULTS> = {}) => ({
    ...APPS_STORE_DEFAULTS,
    ...over,
  });

  /** Round-trip through the real boundary schema — this is what "carried" means. */
  const throughSchema = (context: ReturnType<typeof buildAppsStoreFeedbackContext>) =>
    createFeedbackSchema.parse({
      area: 'apps-marketplace',
      message: 'the store looked wrong',
      context,
    }).context;

  it('reports the path and every store control', () => {
    const context = buildAppsStoreFeedbackContext({
      path: '/apps',
      filters: filters({
        kind: 'offsite',
        category: 'generation',
        sort: 'newest',
        query: 'upscale',
      }),
    });

    expect(context?.path).toBe('/apps');
    expect(context?.filters).toEqual({
      kind: 'offsite',
      category: 'generation',
      sort: 'newest',
      query: 'upscale',
    });
  });

  // Literal defaults, hand-typed rather than read back out of APPS_STORE_DEFAULTS, so
  // a change to the store's defaults surfaces here instead of being followed silently.
  it('reports the DEFAULT view rather than an empty object', () => {
    const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters() });
    expect(context?.filters).toEqual({
      kind: 'all',
      category: 'none',
      sort: 'top-rated',
      query: '',
    });
  });

  it("says 'none' for no category instead of dropping the key", () => {
    const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters() });
    expect(context?.filters).toHaveProperty('category');
    expect(context?.filters?.category).toBe('none');
  });

  // SSR: the builder runs during the server render too, where there is no `window`.
  it('carries an absent path without failing the boundary schema', () => {
    const context = buildAppsStoreFeedbackContext({ filters: filters() });
    expect(context?.path).toBeUndefined();
    expect(throughSchema(context)?.filters?.kind).toBe('all');
  });

  /**
   * 🔴 THE STORAGE-SHAPE CASE. Decided while the table held no rows, because it stops
   * being free the moment it does: a column carrying both `'upscale'` and `'  upscale  '`
   * fragments every later aggregate over it, and no later change can un-mix the rows.
   *
   * `resolveAppsStoreFilters` trims only to TEST emptiness and then keeps the original,
   * so the untrimmed term really does reach this builder — the first assertion below
   * pins that premise rather than assuming it.
   *
   * Whitespace is droppable because it is provably not signal: the store's matcher is
   * `debouncedSearch.trim().toLowerCase()`, so surrounding space cannot change which
   * listings the reporter saw. Case survives that same argument but is KEPT, because it
   * is readable and `lower()` recovers grouping at read time while folded case is gone
   * for good. The case control below is what makes that a decision instead of an
   * accident — it fails against a `.toLowerCase()` in the builder.
   */
  describe('the search term is TRIMMED for storage, but not case-folded', () => {
    // The premise. If `resolveAppsStoreFilters` ever starts trimming, this goes red and
    // the trim in the builder becomes redundant rather than silently load-bearing.
    it('receives an untrimmed term from the store filter resolver', () => {
      expect(resolveAppsStoreFilters({ query: '  upscale  ' }).query).toBe('  upscale  ');
    });

    it('drops surrounding whitespace so two spellings of one term agree', () => {
      const padded = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: '  upscale  ' }),
      });
      const bare = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: 'upscale' }),
      });

      expect(padded?.filters?.query).toBe('upscale');
      expect(padded?.filters?.query).toBe(bare?.filters?.query);
      expect(throughSchema(padded)?.filters?.query).toBe('upscale');
    });

    // Tabs/newlines reach `?query=` through a paste or a hand-edited address bar, and
    // `\s` is what the matcher's own `trim()` removes — so pin the same class, not just
    // the space character.
    it('drops tabs and newlines too, not just spaces', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: '\t\n upscale \n\t' }),
      });
      expect(context?.filters?.query).toBe('upscale');
    });

    /**
     * 🔴 THE PADDING CLASS MUST BE `trim()`'s, NOT ASCII. Every fixture above pads with
     * space/tab/newline, and a fixture that cannot contain an exotic space cannot observe
     * a narrowed whitespace class — a hand-rolled
     * `replace(/^[ \t\n]+|[ \t\n]+$/g, '')` passes all of them while leaving NBSP-padded
     * terms untrimmed, reintroducing exactly the fragmentation this change exists to
     * prevent. NBSP is the COMMON real case: pasting a term out of a rendered page carries
     * U+00A0, not a space.
     *
     * The set is `String.prototype.trim`'s own: WhiteSpace + LineTerminator, which includes
     * NBSP (U+00A0), BOM (U+FEFF), CR, VT/FF, LS/PS (U+2028/9) and ideographic space
     * (U+3000). NOTE: nothing here EXERCISES the store's matcher, so this table does not
     * enforce that the two stay in step — if `AppListingsMarketplaceBody.tsx:331` stopped
     * using `trim()`, no assertion in this file would go red. It pins our side only.
     */
    const TRIMMED_CHARS: [string, string][] = [
      // The ASCII three belong in the table too, not only in the mixed-padding case above:
      // leaving them out left interior TAB unpinned, and `replace(/\t+/g, ' ')` survived a
      // fully green suite on exactly that hole. The table IS the class — nothing here is
      // "covered elsewhere".
      ['space', ' '],
      ['tab', '\t'],
      ['newline', '\n'],
      ['NBSP', '\u00A0'],
      ['BOM / ZWNBSP', '\uFEFF'],
      ['ideographic space', '\u3000'],
      ['carriage return', '\r'],
      ['vertical tab', '\v'],
      ['form feed', '\f'],
      ['line separator', '\u2028'],
      ['paragraph separator', '\u2029'],
    ];

    it.each(TRIMMED_CHARS)('drops %s padding, not just ASCII whitespace', (_label, pad) => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: `${pad}upscale${pad}` }),
      });
      expect(context?.filters?.query).toBe('upscale');
    });

    /**
     * 🔴 THE SAME BLIND SPOT, ONE POSITION OVER. The table above places each exotic
     * character only in the PADDING, so the term's INTERIOR is ASCII in every fixture —
     * and a fixture whose interior cannot contain the character cannot observe an
     * implementation that rewrites it there. Four mutants survived a fully green suite on
     * exactly that gap, including `replace(/\uFEFF/g, '')` (a global BOM strip, a very
     * common real idiom) and `replace(/\u00A0/g, ' ')`.
     *
     * Trimming the ends and rewriting the middle are different decisions: this change
     * takes the first and explicitly declines the second, because the middle is what the
     * reporter actually typed. So every character the table trims at the ends must be
     * proven to SURVIVE in the interior.
     *
     * 🔴 The interior carries a SINGLE occurrence AND a DOUBLED one, because position and
     * OCCURRENCE-COUNT are separate holes. With only a single occurrence the run-collapsing
     * mutants survive — `replace(/\n{2,}/g, '\n')` and `replace(/\t{2,}/g, '\t')` both did
     * — and collapsing blank lines is exactly the "tidy a pasted term" idiom someone
     * reaches for. Same class as the padding-vs-interior hole above, one dimension over.
     */
    it.each(TRIMMED_CHARS)('keeps %s INSIDE the term, where it is not padding', (_label, ch) => {
      const query = `up${ch}scale${ch}${ch}down`;
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query }),
      });
      expect(context?.filters?.query).toBe(query);
    });

    /**
     * CRLF specifically. The doubled-occurrence table above pairs each character with
     * ITSELF, so it produces `\r\r` and `\n\n` but never the `\r\n` SEQUENCE — and
     * `replace(/\r\n/g, '\n')`, line-ending normalisation and the most reached-for text
     * tidy of all, survives on exactly that gap. A term pasted out of a Windows editor
     * carries CRLF.
     */
    it('keeps a CRLF sequence inside the term', () => {
      const query = 'up\r\nscale';
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query }),
      });
      expect(context?.filters?.query).toBe(query);
    });

    /**
     * 🔴 NO UNICODE NORMALISATION. `.normalize('NFKC')` is the plausible "tidy the term"
     * addition and it is a storage-shape REWRITE, not a tidy: it maps fullwidth `Ｂｉｔ`
     * to `Bit`, folding characters the reporter deliberately typed. The module doc says
     * "normalise away only what can never be wanted back"; nothing tested that until now,
     * and both `NFKC` and `NFC` survived the suite.
     */
    it('does not Unicode-normalise the term (NFKC would fold fullwidth)', () => {
      const query = '\uFF22\uFF49\uFF54\uFF44\uFF45\uFF58'; // fullwidth "Bitdex"
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query }),
      });
      expect(context?.filters?.query).toBe(query);
      expect(context?.filters?.query).not.toBe('Bitdex');
    });

    /**
     * The fullwidth fixture above cannot see `.normalize('NFC')` — fullwidth characters
     * are already NFC-stable, so that mutant survives it. NFC's real effect is COMPOSING a
     * decomposed sequence, so it takes a decomposed fixture to observe. This is the
     * common real input: text pasted from macOS is frequently NFD.
     */
    it('does not compose a decomposed term (NFC)', () => {
      const query = 'cafe\u0301'; // "cafe" + COMBINING ACUTE — NFD, composes to "café"
      expect(query.normalize('NFC')).not.toBe(query); // the fixture can see NFC at all
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query }),
      });
      expect(context?.filters?.query).toBe(query);
    });

    /**
     * 🔴 AND THE DECOMPOSING DIRECTION. The two fixtures above pin only the COMPOSING
     * normalisations: NFD is the identity on both of them (fullwidth has no canonical
     * decomposition, and `cafe\u0301` is already decomposed), so `.normalize('NFD')`
     * survived them both while the comment overhead claimed "NO UNICODE NORMALISATION".
     * Decomposing is the same silent storage-shape rewrite as composing, and normalising
     * to NFD is a real search-folding idiom. It takes a PRECOMPOSED fixture to see it.
     */
    it('does not decompose a precomposed term (NFD)', () => {
      const query = 'caf\u00E9'; // precomposed U+00E9 — NFD would split it into e + U+0301
      expect(query.normalize('NFD')).not.toBe(query); // the fixture can see NFD at all
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query }),
      });
      expect(context?.filters?.query).toBe(query);
    });

    /**
     * CONTROL 1 — interior whitespace must survive, RUNS INCLUDED. A fix that reached for
     * `replace(/\s/g, '')` rather than `trim()` would pass every assertion above and
     * silently destroy every multi-word search term.
     *
     * 🔴 The interior runs are of DIFFERENT LENGTHS on purpose. With a single interior
     * space this fixture cannot distinguish `trim()` from `trim()` + an interior collapse
     * (`replace(/\s+/g, ' ')`) — both yield `'anime upscale'` — so that mutant survived a
     * fully green suite. Collapsing runs is a different storage-shape decision than
     * trimming (it silently rewrites what the reporter typed) and is not one this change
     * takes, so the fixture has to be able to see it.
     *
     * Carrying BOTH a 2-run and a 3-run kills the whole width-indexed family in one
     * fixture: a collapse written `/\s+/`, `/\s\s+/`, `/\s{2}/` or `/\s{3,}/` moves at
     * least one of the two runs. A single 2-run left `/\s{3,}/` alive.
     */
    it('keeps whitespace INSIDE the term, including runs of differing length', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: '  anime  upscale   pro  ' }),
      });
      expect(context?.filters?.query).toBe('anime  upscale   pro');
    });

    /**
     * CONTROL 2 — case is NOT folded. This is the assertion that pins the half of the
     * decision we chose not to take; it fails the moment someone "finishes the job"
     * with a `.toLowerCase()`.
     */
    it('preserves the case the reporter typed', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: '  BitDex  ' }),
      });
      expect(context?.filters?.query).toBe('BitDex');
    });

    /**
     * CONTROL 3 — trimming must not disturb the empty case. `''` is the explicit
     * "searched for nothing" marker (same reading as `category: 'none'`), and a
     * whitespace-only term already resolves to it upstream.
     */
    it('leaves the empty term as the empty string', () => {
      expect(resolveAppsStoreFilters({ query: '   ' }).query).toBe('');
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: '   ' }),
      });
      expect(context?.filters).toHaveProperty('query');
      expect(context?.filters?.query).toBe('');
    });

    /**
     * The trim runs BEFORE the clip, so the bound applies to the real term rather than
     * to whitespace about to be discarded. Clip-then-trim gives 195 characters here;
     * trim-then-clip gives the full 200.
     */
    it('applies the bound to the term, not to the padding around it', () => {
      const query = `     ${'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 50)}     `;
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });

      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      expect(context?.filters?.query).toBe('q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH));
      expect(() => throughSchema(context)).not.toThrow();
    });
  });

  describe('the search term is CLIPPED to the schema bound, not passed through', () => {
    it('pins the bound this file is written against', () => {
      expect(FEEDBACK_FILTER_VALUE_MAX_LENGTH).toBe(200);
    });

    it('leaves a term inside the bound untouched', () => {
      const query = 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });
      expect(context?.filters?.query).toBe(query);
      expect(throughSchema(context)?.filters?.query).toBe(query);
    });

    /**
     * THE REGRESSION CASE. Without the clip this parse THROWS, and the reporter gets
     * a validation error instead of a filed report. Asserted through the schema, at
     * one character over the bound and again far over it.
     */
    it('clips a term one character past the bound so the submission still parses', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 1) }),
      });
      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      expect(() => throughSchema(context)).not.toThrow();
      expect(throughSchema(context)?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
    });

    it('clips a pathologically long term the same way', () => {
      const context = buildAppsStoreFeedbackContext({
        path: '/apps',
        filters: filters({ query: 'x'.repeat(20_000) }),
      });
      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
      expect(() => throughSchema(context)).not.toThrow();
    });

    /**
     * 🔴 THE SURROGATE CASE. Every fixture above is ASCII, and a fixture that cannot
     * contain a surrogate pair cannot observe a surrogate bug — which is exactly why
     * this shipped.
     *
     * `slice` cuts on UTF-16 CODE UNITS, not characters. An astral-plane character
     * (any emoji) is a pair of units, so a clip point that lands between them leaves
     * a LONE HIGH SURROGATE as the last unit. That string is a legal JS value and
     * passes `z.string().max()` untouched, so the schema round-trip below cannot see
     * it either — it breaks one layer further down, where the context is written to
     * the `Feedback.context` JSON column: `JSON.stringify` emits a bare `\ud83d`
     * escape, which Postgres rejects (`Unicode low surrogate must follow a high
     * surrogate`) and Prisma's serde layer rejects before that. So the clip added to
     * keep a long search term from failing the submission ends up failing the
     * submission itself, on the one surface that exists to accept reports.
     *
     * Asserted as a STATE (`isWellFormed`, plus a real UTF-8 encode round-trip)
     * rather than by looking for an escape sequence in the output: a well-formed
     * string is the property the downstream write actually needs, and a lone
     * surrogate is the only way to lose it.
     */
    const EMOJI = '\u{1F600}'; // U+1F600, two UTF-16 units: \uD83D \uDE00

    /** Encoding to UTF-8 and back is lossless iff the string has no lone surrogate. */
    const survivesUtf8 = (value: string) =>
      new TextDecoder().decode(new TextEncoder().encode(value)) === value;

    it('does not leave a lone surrogate when the bound falls inside an emoji', () => {
      // 199 ASCII + one emoji = 201 units, so unit 200 is the emoji's HIGH surrogate.
      const query = 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1) + EMOJI;
      expect(query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 1);

      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });
      const clipped = context?.filters?.query as string;

      expect(clipped.isWellFormed()).toBe(true);
      expect(survivesUtf8(clipped)).toBe(true);
      // Exactly the orphaned unit is dropped — the whole pair, and nothing more.
      expect(clipped).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1);
      expect(clipped).toBe('q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1));
      expect(throughSchema(context)?.filters?.query).toBe(clipped);
    });

    it('does not leave a lone surrogate for a term that is mostly emoji', () => {
      // One ASCII char shifts every pair onto an odd offset, so the clip at 200 lands
      // mid-pair. (A term of ONLY emoji does not break at this bound: 200 is even, so
      // the cut falls exactly on a pair boundary — which is why the fixture is mixed.)
      const query = 'q' + EMOJI.repeat(150);
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });
      const clipped = context?.filters?.query as string;

      expect(clipped.isWellFormed()).toBe(true);
      expect(survivesUtf8(clipped)).toBe(true);
      expect(clipped).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH - 1);
      expect(clipped.endsWith(EMOJI)).toBe(true);
      expect(throughSchema(context)?.filters?.query).toBe(clipped);
    });

    /**
     * The control for the two above: when the clip point does NOT fall inside a pair,
     * nothing extra may be trimmed. Without it, a guard that simply dropped the last
     * unit of every clipped term would pass both cases above.
     */
    it('trims nothing extra when the bound falls on a character boundary', () => {
      const query = 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH) + EMOJI;
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });

      expect(context?.filters?.query).toBe('q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH));
      expect(context?.filters?.query).toHaveLength(FEEDBACK_FILTER_VALUE_MAX_LENGTH);
    });

    /** And an emoji comfortably inside the bound is not touched at all. */
    it('leaves an emoji inside the bound intact', () => {
      const query = `upscale ${EMOJI}`;
      const context = buildAppsStoreFeedbackContext({ path: '/apps', filters: filters({ query }) });

      expect(context?.filters?.query).toBe(query);
      expect(throughSchema(context)?.filters?.query).toBe(query);
    });

    /**
     * The control for the two cases above: an UNCLIPPED value of the same shape is
     * genuinely rejected. Without this, "does not throw" would be indistinguishable
     * from a schema that has no bound at all.
     */
    it('and the unclipped value really is rejected (negative control)', () => {
      expect(() =>
        createFeedbackSchema.parse({
          area: 'apps-marketplace',
          message: 'the store looked wrong',
          context: { filters: { query: 'q'.repeat(FEEDBACK_FILTER_VALUE_MAX_LENGTH + 1) } },
        })
      ).toThrow();
    });
  });
});
