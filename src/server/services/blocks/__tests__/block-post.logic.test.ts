import { describe, expect, it } from 'vitest';

import {
  BLOCK_POST_DETAIL_MAX,
  BLOCK_POST_MAX_IMAGES,
  BLOCK_POST_MAX_TAGS,
  BLOCK_POST_TITLE_MAX,
  normalizeBlockPostTagNames,
  readWorkflowResourceVersionIds,
  resolveWorkflowOutputSelection,
  validateBlockPostText,
} from '~/server/services/blocks/block-post.logic';

/**
 * The PURE half of the App-Blocks → Post bridge.
 *
 * Every expectation below is a LITERAL, derived from the rule the function is
 * supposed to implement — never from reading the implementation back. Where a
 * bound is involved the case is built from the exported constant ± 1 so it stays
 * correct if the constant moves, AND a second case pins a value the constant
 * cannot equal, so a mutant that hardcodes the constant's own value cannot
 * survive.
 */
describe('validateBlockPostText', () => {
  it('trims, and collapses empty/whitespace to null rather than an empty string', () => {
    expect(validateBlockPostText({ title: '  hello  ', detail: '\n world \n' })).toEqual({
      ok: true,
      title: 'hello',
      detail: 'world',
    });
    expect(validateBlockPostText({ title: '   ', detail: '' })).toEqual({
      ok: true,
      title: null,
      detail: null,
    });
    expect(validateBlockPostText({})).toEqual({ ok: true, title: null, detail: null });
  });

  it('accepts a title of exactly the cap and refuses one character more', () => {
    const atCap = 'a'.repeat(BLOCK_POST_TITLE_MAX);
    expect(validateBlockPostText({ title: atCap })).toEqual({
      ok: true,
      title: atCap,
      detail: null,
    });
    const overCap = 'a'.repeat(BLOCK_POST_TITLE_MAX + 1);
    expect(validateBlockPostText({ title: overCap })).toEqual({
      ok: false,
      reason: `title exceeds ${BLOCK_POST_TITLE_MAX} characters`,
    });
  });

  it('accepts a detail of exactly the cap and refuses one character more', () => {
    const atCap = 'b'.repeat(BLOCK_POST_DETAIL_MAX);
    expect(validateBlockPostText({ detail: atCap }).ok).toBe(true);
    expect(validateBlockPostText({ detail: 'b'.repeat(BLOCK_POST_DETAIL_MAX + 1) })).toEqual({
      ok: false,
      reason: `detail exceeds ${BLOCK_POST_DETAIL_MAX} characters`,
    });
  });

  it('the two bounds are INDEPENDENT — a 1000-char detail is fine, a 1000-char title is not', () => {
    // 1000 is chosen because it is > TITLE_MAX and < DETAIL_MAX, so a mutant that
    // applied one bound to both fields dies here. Neither literal equals either
    // constant, so the case cannot be satisfied by hardcoding a constant.
    const text = 'c'.repeat(1000);
    expect(validateBlockPostText({ detail: text }).ok).toBe(true);
    expect(validateBlockPostText({ title: text }).ok).toBe(false);
  });

  describe('link refusal — a sandboxed app must not publish outbound links as the viewer', () => {
    it.each([
      ['https://evil.example/claim', 'an https scheme'],
      ['http://evil.example', 'an http scheme'],
      ['visit www.somewhere.test now', 'a bare www host'],
      ['dm me at freebuzz.click', 'a schemeless domain with a risky TLD'],
      ['see civitai.com/x', 'a schemeless domain with a common TLD'],
    ])('refuses detail containing %j (%s)', (detail) => {
      expect(validateBlockPostText({ detail })).toEqual({
        ok: false,
        reason: 'detail may not contain links',
      });
    });

    it('refuses a link in the TITLE too, with the title-specific reason', () => {
      // A guard that only screened `detail` would pass this. The distinct reason
      // string is what proves WHICH branch fired — a shared message would let the
      // detail branch take credit for the title case.
      expect(validateBlockPostText({ title: 'free buzz at https://evil.example' })).toEqual({
        ok: false,
        reason: 'title may not contain links',
      });
    });

    it('does NOT refuse ordinary prose that merely contains dots or a slash', () => {
      // The refusal must not be so broad that normal copy is unpublishable —
      // otherwise the control gets removed rather than respected.
      const ok = validateBlockPostText({
        title: 'Study no. 4',
        detail: 'Rendered at 1024x1024. Steps 30/cfg 7. Mood: calm, a bit eerie...',
      });
      expect(ok.ok).toBe(true);
    });
  });
});

describe('normalizeBlockPostTagNames', () => {
  it('lowercases, trims, drops empties and non-strings', () => {
    expect(
      normalizeBlockPostTagNames(['  Anime ', 'PORTRAIT', '', '   ', 42, null, undefined])
    ).toEqual(['anime', 'portrait']);
  });

  it('dedupes case-insensitively BEFORE applying the cap', () => {
    // The order matters: a cap applied before dedupe would let one repeated name
    // consume the whole budget. Six names, five distinct → all five survive.
    expect(normalizeBlockPostTagNames(['a', 'A', 'b', 'c', 'd', 'e'])).toEqual([
      'a',
      'b',
      'c',
      'd',
      'e',
    ]);
  });

  it(`caps at ${BLOCK_POST_MAX_TAGS} distinct names, keeping the first ones`, () => {
    const many = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'];
    const out = normalizeBlockPostTagNames(many);
    expect(out).toHaveLength(BLOCK_POST_MAX_TAGS);
    expect(out).toEqual(many.slice(0, BLOCK_POST_MAX_TAGS));
  });

  it('drops an absurdly long name rather than truncating it', () => {
    expect(normalizeBlockPostTagNames(['x'.repeat(101), 'ok'])).toEqual(['ok']);
  });

  it('returns [] for a non-array', () => {
    expect(normalizeBlockPostTagNames('anime')).toEqual([]);
    expect(normalizeBlockPostTagNames(undefined)).toEqual([]);
  });

  it('STRIPS control and format characters — an unresolved name is rendered as host chrome', () => {
    // 🔴 WHY A PURE TAG NORMALISER CARES ABOUT DISPLAY. A name that resolves to no
    // `Tag` row is not discarded: it comes back as `droppedTags` and is rendered
    // verbatim in the consent dialog, so these strings reach the host surface the
    // block is otherwise forbidden to write to. `String.trim()` removes none of
    // them.
    //
    // Real code points, written as escapes so no editor or transport can eat
    // them: U+202E RIGHT-TO-LEFT OVERRIDE (reverses the display of everything
    // after it), U+200B ZERO WIDTH SPACE (invisible padding), U+0007 BELL (a
    // control char — mapped to a space so words do not fuse).
    expect(normalizeBlockPostTagNames(['saf‮elbmargorp'])).toEqual(['safelbmargorp']);
    expect(normalizeBlockPostTagNames(['zero​width'])).toEqual(['zerowidth']);
    expect(normalizeBlockPostTagNames(['bellx'])).toEqual(['bell x']);
    // A name made only of invisible characters collapses to empty and is dropped
    // — the existing empty-name rule, now reachable for this class too.
    expect(normalizeBlockPostTagNames(['‮​', 'ok'])).toEqual(['ok']);
  });

  it('collapses whitespace runs, including ones a control char produced', () => {
    // A tag name is a single line by definition; a newline inside one would break
    // the dialog's comma-joined list into two visual rows.
    expect(normalizeBlockPostTagNames(['two\n\nwords'])).toEqual(['two words']);
    expect(normalizeBlockPostTagNames(['a   b'])).toEqual(['a b']);
  });

  it('strips BEFORE the length cap, so padding cannot push a real name over it', () => {
    // The cap is 100 characters. 100 real characters plus 10 zero-width ones is
    // 110 raw — a pre-strip length test would discard a perfectly legal name.
    const padded = 'x'.repeat(100) + '​'.repeat(10);
    expect(normalizeBlockPostTagNames([padded])).toEqual(['x'.repeat(100)]);
    // And the reverse still holds: 101 REAL characters is still too long.
    expect(normalizeBlockPostTagNames(['x'.repeat(101)])).toEqual([]);
  });
});

describe('resolveWorkflowOutputSelection', () => {
  it('defaults to every available index when none are requested', () => {
    expect(
      resolveWorkflowOutputSelection({ requested: undefined, availableCount: 3, maxCount: 20 })
    ).toEqual([0, 1, 2]);
  });

  it('preserves REQUEST order, not sorted order', () => {
    // Post order is the viewer-visible consequence, so request order is the
    // contract. A mutant that sorted would look correct on [0,1,2].
    expect(
      resolveWorkflowOutputSelection({ requested: [2, 0, 1], availableCount: 3, maxCount: 20 })
    ).toEqual([2, 0, 1]);
  });

  it('drops out-of-range, negative, non-integer and duplicate indexes', () => {
    expect(
      resolveWorkflowOutputSelection({
        requested: [0, 0, -1, 2, 7, 1.5, 1],
        availableCount: 3,
        maxCount: 20,
      })
    ).toEqual([0, 2, 1]);
  });

  it('stops at maxCount', () => {
    // maxCount 3 against 10 available: deliberately NOT a divisor or multiple of
    // the default cap, so a mutant substituting BLOCK_POST_MAX_IMAGES dies.
    expect(
      resolveWorkflowOutputSelection({ requested: undefined, availableCount: 10, maxCount: 3 })
    ).toEqual([0, 1, 2]);
    expect(BLOCK_POST_MAX_IMAGES).not.toBe(3);
  });

  it('returns [] when nothing valid was asked for', () => {
    expect(
      resolveWorkflowOutputSelection({ requested: [9, 10], availableCount: 2, maxCount: 20 })
    ).toEqual([]);
    expect(
      resolveWorkflowOutputSelection({ requested: undefined, availableCount: 0, maxCount: 20 })
    ).toEqual([]);
  });
});

/**
 * 🔴 `readWorkflowResourceVersionIds` — the only server-side evidence relating a
 * post's IMAGES to its gallery ATTACH.
 *
 * Every id below is pairwise distinct AND distinct from every other constant in
 * this file, so a mutant that returned the wrong carrier's value, or one that
 * returned a constant, cannot survive by coincidence.
 *
 * ⚠️ The property under test is "what can be READ", never "what was used". An
 * empty result means nothing was readable — the consuming guard is built around
 * exactly that, so a case here that produces `[]` is pinning an ABSENCE OF
 * EVIDENCE and says so.
 */
describe('readWorkflowResourceVersionIds', () => {
  const CHECKPOINT = 7101;
  const LORA = 7202;
  const STEP_RESOURCE = 7303;
  const AIR_VERSION = 7404;

  it('reads `metadata.resources[].id`', () => {
    expect(
      readWorkflowResourceVersionIds({ metadata: { resources: [{ id: CHECKPOINT }] } })
    ).toEqual([CHECKPOINT]);
  });

  it('reads `metadata.params.resources[].id` — the nested spelling', () => {
    expect(
      readWorkflowResourceVersionIds({ metadata: { params: { resources: [{ id: LORA }] } } })
    ).toEqual([LORA]);
  });

  it('reads a per-STEP metadata record', () => {
    expect(
      readWorkflowResourceVersionIds({
        steps: [{ metadata: { params: { resources: [{ id: STEP_RESOURCE }] } } }],
      })
    ).toEqual([STEP_RESOURCE]);
  });

  it('reads a civitai AIR on `steps[].input.model`', () => {
    expect(
      readWorkflowResourceVersionIds({
        steps: [{ input: { model: `urn:air:sd1:checkpoint:civitai:900@${AIR_VERSION}` } }],
      })
    ).toEqual([AIR_VERSION]);
  });

  it('reads the AIR KEYS of `additionalNetworks` — the value carries only strength', () => {
    expect(
      readWorkflowResourceVersionIds({
        steps: [
          {
            input: {
              additionalNetworks: {
                [`urn:air:sd1:lora:civitai:901@${LORA}`]: { strength: 0.8 },
              },
            },
          },
        ],
      })
    ).toEqual([LORA]);
  });

  it('reads a custom-graph step’s explicit AIR list', () => {
    expect(
      readWorkflowResourceVersionIds({
        steps: [{ input: { resources: [`urn:air:sd1:lora:civitai:902@${STEP_RESOURCE}`] } }],
      })
    ).toEqual([STEP_RESOURCE]);
  });

  it('UNIONS every carrier and de-duplicates', () => {
    // The case that fails for a mutant reading only the first carrier it finds.
    const out = readWorkflowResourceVersionIds({
      metadata: { resources: [{ id: CHECKPOINT }] },
      steps: [
        { metadata: { resources: [{ id: LORA }] } },
        {
          input: {
            model: `urn:air:sd1:checkpoint:civitai:900@${CHECKPOINT}`,
            additionalNetworks: { [`urn:air:sd1:lora:civitai:903@${AIR_VERSION}`]: {} },
          },
        },
      ],
    });
    expect([...out].sort((a, b) => a - b)).toEqual(
      [CHECKPOINT, LORA, AIR_VERSION].sort((a, b) => a - b)
    );
  });

  it('SKIPS a non-civitai AIR that DOES carry a numeric version', () => {
    // 🔴 THE FIXTURE IS THE WHOLE TEST, AND THE OBVIOUS ONE IS VACUOUS. A
    // realistic-looking orchestrator AIR such as
    // `urn:air:sd1:lora:orchestrator:job-abc/file.safetensors` parses to
    // `version: null`, so it is dropped by the integer check regardless of the
    // source check — a mutant that deleted `source === 'civitai'` SURVIVES that
    // fixture, measured. These two parse to real numbers (5678 and 1), so they
    // are admitted the moment the source check goes, which is what makes this a
    // test of the source check rather than of the integer check.
    //
    // Neither id has a `ModelVersion` behind it: one is an orchestrator-hosted
    // asset, the other a comfy node pack. Admitting either would put a value in
    // the set that can never legitimately match a gallery target, while making
    // the set look populated to a caller that distinguishes empty from non-empty.
    expect(
      readWorkflowResourceVersionIds({
        steps: [
          {
            input: {
              resources: [
                'urn:air:sdxl:checkpoint:orchestrator:1234@5678',
                'urn:air:comfy:nodepack:comfy:some-pack@1',
              ],
            },
          },
        ],
      })
    ).toEqual([]);
  });

  it('SKIPS an AIR whose version is not a number at all', () => {
    expect(
      readWorkflowResourceVersionIds({
        steps: [
          { input: { resources: ['urn:air:sd1:lora:orchestrator:job-abc/file.safetensors'] } },
        ],
      })
    ).toEqual([]);
  });

  it('SKIPS non-integer and non-positive ids', () => {
    expect(
      readWorkflowResourceVersionIds({
        metadata: {
          resources: [{ id: 0 }, { id: -5 }, { id: 1.5 }, { id: '7101' }, { id: null }],
        },
      })
    ).toEqual([]);
  });

  it('ABSENCE OF EVIDENCE: a workflow with no readable carrier reports []', () => {
    // NOT "no resources were used". The consuming guard must treat this as
    // unknown, and does — see `assertGalleryTargetMatchesSources`.
    expect(readWorkflowResourceVersionIds({ steps: [{ $type: 'comfy', input: {} }] })).toEqual([]);
  });

  it('never throws on a malformed payload — a bad field costs that field, not the request', () => {
    for (const bad of [null, undefined, 42, 'workflow', [], { steps: 'nope' }, { metadata: 7 }]) {
      expect(readWorkflowResourceVersionIds(bad)).toEqual([]);
    }
    expect(
      readWorkflowResourceVersionIds({
        metadata: { resources: [null, 'x', 5, { id: CHECKPOINT }] },
        steps: [null, 'x', { input: null }, { input: { additionalNetworks: 'x' } }],
      })
    ).toEqual([CHECKPOINT]);
  });
});
