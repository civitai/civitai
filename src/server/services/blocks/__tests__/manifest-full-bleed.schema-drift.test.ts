import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { BlockManifestValidator } from '~/server/services/block-manifest-validator.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

/**
 * Drift guard — manifest `page.fullBleed`, the app's SELF-SERVICE opt-out from the
 * full-page run host's width cap.
 *
 * TWO declarations of the same rule, and they must never diverge:
 *   1. the canonical published schema `public/schemas/app-block/v1.json` — what the
 *      `civitai` CLI mirrors, what editors validate against, and what an author
 *      sees BEFORE they submit,
 *   2. `BlockManifestValidator.validate` — the imperative validator, the
 *      authoritative gate at submit/approve.
 *
 * 🔴 THE DIRECTION OF DIVERGENCE THAT HURTS is the schema being MORE PERMISSIVE
 * than the server: an author green in their editor and rejected at submit, with
 * nothing to explain the difference. Both directions are asserted below, because
 * the OTHER direction bites this field specifically — the schema's `page` block is
 * `additionalProperties: false`, so a key the schema does not know is rejected in
 * the author's editor whatever the server thinks, and that is the whole reason the
 * schema had to move first for this feature to exist at all.
 *
 * 🔴 AND IT CHECKS THE DESCRIPTION, because for THIS field the prose makes
 * MACHINE-CHECKABLE CLAIMS about numbers that live somewhere else. It tells the
 * author what the cap is, which viewport widths the field does NOT affect, and which
 * it does. Every one of those is derived from `APP_PAGE_MAX_WIDTH_PX` in
 * `PageBlockHost.tsx`. Move that constant without touching the prose and the
 * published schema is telling every App Block developer something false about their
 * own layout — a class of rot the `repository` drift guard already records for its
 * host list.
 *
 * 🔴 WHY THIS REPLACED A CSS LEDGER, in one line, because it is the thing a reader
 * of this file most needs to know: full bleed used to require a hand-maintained rule
 * in `src/styles/globals.css` and therefore a pull request to the platform repo, one
 * per app. The manifest field moves the gate to the moderator review the manifest
 * already passes. The ledger's two remaining rules are a migration path, marked as
 * such in that file, and the host honours flag OR rule until they go.
 *
 * WHAT IS **NOT** HERE. Whether the host actually skips the cap is a RENDERED claim
 * and no node-tier file can make it — that lives in
 * `src/components/AppBlocks/PageBlockHostMaxWidth.browser.test.tsx`, as a two-point
 * pair (declared ⇒ uncapped, not declared ⇒ capped). The source-level half — that
 * the host's own style block branches on the prop — is in
 * `src/components/AppBlocks/__tests__/pageBlockHostMaxWidth.test.ts`.
 */
const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const SCHEMA_PATH = path.join(REPO_ROOT, 'public/schemas/app-block/v1.json');
const HOST_PATH = path.join(REPO_ROOT, 'src/components/AppBlocks/PageBlockHost.tsx');
const VALIDATOR_PATH = path.join(
  REPO_ROOT,
  'src/server/services/block-manifest-validator.service.ts'
);

/**
 * Read a file, proving the path first.
 *
 * A comparison against an absent operand reports SAME, not MISSING — so a renamed
 * file would otherwise turn every assertion below into a vacuous pass on an empty
 * string, which is exactly the reassuring zero this repo's guards refuse.
 */
function read(file: string): string {
  const rel = path.relative(REPO_ROOT, file);
  let src: string;
  try {
    src = readFileSync(file, 'utf8');
  } catch {
    throw new Error(
      `${rel} does not exist. This guard reads it to compare the published schema ` +
        'against the code; re-point it deliberately rather than letting it pass on nothing.'
    );
  }
  expect(src.length, `${rel} is empty`).toBeGreaterThan(0);
  return src;
}

type PageSchema = {
  type?: unknown;
  required?: unknown;
  additionalProperties?: unknown;
  properties?: Record<string, { type?: unknown; default?: unknown; description?: unknown }>;
};

const schema = JSON.parse(read(SCHEMA_PATH)) as {
  properties?: { page?: PageSchema };
};

const pageSchema = schema.properties?.page;
const fullBleed = pageSchema?.properties?.fullBleed;
const description = String(fullBleed?.description ?? '');

/**
 * Collapse every whitespace run to one space and trim.
 *
 * The ONLY edit the whole-string pin below is meant to survive is re-wrapping —
 * the published schema is a JSON file whose description is one long line, and the
 * expected copy here is wrapped to fit the editor. Normalising both sides with the
 * same function is what makes those two spellings the same claim.
 */
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/**
 * The published `page.fullBleed` description, VERBATIM.
 *
 * 🔴 WHEN THE ARTIFACT UNDER TEST IS PROSE, A GUARD ON WORDS IS WALKABLE BY
 * REWORDING. This pin replaces a pair of substring checks (`omit it` +
 * /full-page run host only/i) that were MEASURED to be inert against a
 * meaning-INVERTING reword: rewriting the opening as "Opt this app INTO the
 * full-page run host's width cap … renders it as a centred column instead of edge
 * to edge" and the default sentence as "OMIT IT (or set false) and the host renders
 * your app edge to edge, with no 1600px cap and no neutral gutter either side" left
 * every numeric token intact, kept BOTH substrings present, and left this file
 * 11/11 green — a published description telling every App Block author the exact
 * opposite of what the host does, with a guard sitting over it reporting nothing.
 *
 * 🔴 THE COST IS ACCEPTED DELIBERATELY: a cosmetic reword — fixing a typo,
 * re-punctuating a clause — now fails this test and has to be paid for by updating
 * the copy below in the same commit. That is the price of a machine-readable claim
 * about prose; a guard that only samples words cannot make one.
 */
const FULL_BLEED_DESCRIPTION = `
  Opt this app OUT of the full-page run host's width cap, so /apps/run/<slug> renders it edge
  to edge instead of as a centred column. Honoured by the full-page run host only; the
  model-page slot surfaces impose no such cap and ignore this field. OMIT IT (or set false)
  and the host caps your app at 1600px with a neutral gutter either side — that is the default
  every app gets, and it is deliberate: an App Block is a cross-origin guest that is handed a
  viewport and told nothing about the display, and nothing in @civitai/blocks-react gives you
  a container to lay out in, so an uncapped app on a 2560px monitor renders as a single
  ~2500px column. WHAT DECLARING IT CHANGES, AND WHAT IT DOES NOT: the cap is INERT below its
  own width, so this field changes NOTHING at 1280, 1366, 1440 or 1536 (every laptop class),
  nothing on a tablet, and nothing on a phone in either orientation. It changes wide desktop
  displays only — it starts to bind on a maximised browser on a 1080p monitor (~1905 CSS px of
  viewport), where the cap otherwise costs ~150px either side, and on a 2560px display it
  hands your app the remaining ~960px. FOR MOST APPS IT IS COSMETICALLY INERT, SO CHECK YOUR
  OWN CSS FIRST: if your app imposes a max-width of its own, that well binds before this cap
  ever does, and declaring this field changes which background paints the far gutter and
  nothing else - nothing about your content moves, at any width. Nine of the eleven page apps
  shipped today cap themselves between 640 and 1100px and are in exactly that position.
  Declaring it is only worth a review round-trip if your layout is genuinely unbounded. WHEN
  TO DECLARE IT: when a centred column is actively worse for your surface — an infinite grid,
  a timeline, a map, a side-by-side compare, a fullscreen player, or a two-pane shell whose
  fixed sidebar sits beside an unbounded pane. WHEN NOT TO: to look bigger. Your app cannot
  see how wide the viewer's monitor is; an unbounded line length, or a single form stretched
  across 2560px, reads worse than the cap does. This is reviewed like every other field in
  this manifest — a moderator sees it at approve time and may ask what about your surface
  needs it — and it cannot be changed after approval without shipping a new manifest version
  through review. It is also unforgeable at runtime: the host reads the approved manifest, and
  the guest is cross-origin. If you want a DIFFERENT width rather than no width, this field is
  not that; ask a maintainer.
`;

/**
 * `APP_PAGE_MAX_WIDTH_PX`, read out of `PageBlockHost.tsx` BY REGEX rather than
 * imported.
 *
 * 🔴 NOT AN IMPORT, FOR TWO REASONS. `PageBlockHost.tsx` is a large React component
 * with a deep import graph (Mantine, tRPC, the whole block bridge); pulling it into
 * the node `unit` project to read one integer would make this guard's collection
 * depend on all of it, and a collection failure reports "no tests" rather than a red
 * assertion — indistinguishable from a suite wired to nothing. The second reason is
 * the one that matters more: the same regex is the existing spelling in
 * `__tests__/pageBlockHostMaxWidth.test.ts`, so both guards rot the same way and a
 * rename is caught by whichever runs first rather than by neither.
 */
function appPageMaxWidthPx(): number {
  const src = read(HOST_PATH);
  const m = /export const APP_PAGE_MAX_WIDTH_PX = (\d+);/.exec(src);
  expect(
    m,
    'APP_PAGE_MAX_WIDTH_PX was not found in src/components/AppBlocks/PageBlockHost.tsx. Every ' +
      'numeric claim in the published `page.fullBleed` description is derived from it, so ' +
      'without it this guard cannot check the prose against anything. Re-point it rather than ' +
      'deleting it.'
  ).not.toBeNull();
  return Number(m![1]);
}

/** A minimal manifest that VALIDATES, so a single field can be varied against it. */
function manifestWithPage(page: Record<string, unknown>) {
  return {
    blockId: 'full-bleed-fixture',
    version: '1.2.3',
    name: 'Full Bleed Fixture',
    contentRating: 'pg',
    scopes: [] as string[],
    iframe: {
      src: 'https://full-bleed-fixture.civit.ai/',
      minHeight: 640,
      maxHeight: 4000,
      resizable: true,
      sandbox: 'allow-scripts allow-forms',
    },
    page,
  };
}

const APP_CTX = {
  allowedScopes: TokenScope.ModelsRead,
  allowedOrigins: ['https://full-bleed-fixture.civit.ai'],
};

const BASE_PAGE = { path: '/', title: 'Full Bleed Fixture' };

function validate(page: Record<string, unknown>) {
  return BlockManifestValidator.validate(manifestWithPage(page), APP_CTX);
}

describe('app-block v1 schema ⇄ page.fullBleed drift guard', () => {
  it('CONTROL — the fixture manifest validates with no `fullBleed` key at all', () => {
    // The instrument first. Every rejection asserted below has to be attributable to
    // `fullBleed`, and it cannot be if the fixture is refused for some unrelated
    // reason — a fixture that never validates makes every `valid: false` expectation
    // a pass for the wrong reason.
    const result = validate({ ...BASE_PAGE });
    expect(
      result,
      `the fixture manifest is rejected before \`fullBleed\` is even involved: ${
        result.valid ? '' : result.errors.join('; ')
      }`
    ).toEqual({ valid: true });
  });

  it('🔴 an EXISTING manifest is unaffected — the field is optional in both declarations', () => {
    // The additive-compatibility claim, checked rather than asserted. This is the
    // property that makes a change to a public contract safe to ship.
    expect(validate({ ...BASE_PAGE })).toEqual({ valid: true });

    const required = Array.isArray(pageSchema?.required) ? (pageSchema!.required as string[]) : [];
    expect(
      required,
      'the published schema now REQUIRES page.fullBleed. Every manifest already in the wild omits ' +
        'it, so this would invalidate all of them on their next submit.'
    ).not.toContain('fullBleed');
    expect(
      required,
      "the page descriptor's required set changed. It is `path` + `title`; anything else is a " +
        'breaking change to a public contract.'
    ).toEqual(['path', 'title']);
  });

  it('declares fullBleed as an OPTIONAL boolean defaulting to false', () => {
    expect(fullBleed, 'public/schemas/app-block/v1.json has no `page.fullBleed`').toBeDefined();
    expect(fullBleed?.type).toBe('boolean');
    // 🔴 THE DEFAULT IS PART OF THE CONTRACT, NOT DOCUMENTATION. `false` is what
    // keeps the cap the behaviour for the LONG TAIL — an app scaffolded from the
    // starters declares no width of its own, so it inherits whatever this says. ⚠️ IT
    // IS NOT THE SHIPPED FLEET THAT INHERITS IT: nine of the eleven page apps cap
    // themselves at 640-1100px, so the cap is a no-op for their layout whichever way
    // this default points. Citing those nine here would be the wrong witness for the
    // right conclusion. A `default: true` would read as a typo and would tell every
    // author's editor that omitting the field means full bleed, which is the opposite
    // of what the host does (`page.fullBleed === true`).
    expect(fullBleed?.default).toBe(false);
  });

  it('🔴 the page block is still `additionalProperties: false` — the reason the schema had to move', () => {
    // This is WHY a manifest field needed a schema change at all: an unknown key
    // under `page` is refused by editor validation, so the field could not simply be
    // read by the server. It is also the one direction in which this schema is
    // deliberately STRICTER than the server (which ignores unknown keys), and that
    // strictness is load-bearing — it turns a typo like `fullbleed` into an editor
    // error instead of a silently capped app.
    expect(pageSchema?.additionalProperties).toBe(false);
  });

  it('🔴 the server REJECTS a non-boolean, matching the schema `type` rather than coercing', () => {
    for (const bad of ['true', 'false', 1, 0, null, {}, []]) {
      const result = validate({ ...BASE_PAGE, fullBleed: bad });
      expect(result.valid, `the validator ACCEPTED page.fullBleed=${JSON.stringify(bad)}`).toBe(
        false
      );
      expect(
        result.valid ? [] : result.errors,
        `page.fullBleed=${JSON.stringify(bad)} was rejected, but not by the fullBleed rule — so ` +
          'this case is dying for the wrong reason and would still "pass" with that rule deleted'
      ).toContain('page.fullBleed must be a boolean (true or false), not a string or number');
    }
    // …and both real booleans are accepted, or the field is unusable.
    expect(validate({ ...BASE_PAGE, fullBleed: true })).toEqual({ valid: true });
    expect(validate({ ...BASE_PAGE, fullBleed: false })).toEqual({ valid: true });
  });

  it('🔴 the SCHEMA is never more permissive than the server, and never stricter either', () => {
    // The schema is not evaluated on the submit path — nothing in this repo runs a
    // JSON-Schema validator over a manifest — so "they agree" can only be checked as
    // a relationship between the declared type and what the imperative check accepts.
    // Asserted in BOTH directions because each has its own failure mode: schema
    // looser ⇒ green in the editor, refused at submit with nothing explaining it;
    // schema stricter ⇒ an author blocked in their editor from a value the platform
    // would happily take.
    expect(fullBleed?.type).toBe('boolean');
    for (const ok of [true, false]) {
      expect(validate({ ...BASE_PAGE, fullBleed: ok }).valid, `server rejects ${ok}`).toBe(true);
    }
    for (const bad of ['true', 1, null]) {
      expect(
        validate({ ...BASE_PAGE, fullBleed: bad }).valid,
        `the schema declares type boolean but the server ACCEPTS ${JSON.stringify(bad)}`
      ).toBe(false);
    }
  });

  it('🔴 every key the schema declares under `page` is one the validator actually reads', () => {
    // A SEAM, not a component: the defect this catches is a key added to the
    // published schema (so an author's editor accepts it, and `additionalProperties:
    // false` stops complaining) that the server validates nothing about. That is the
    // gap `fullBleed` itself would have been, had only the schema moved.
    //
    // The ledger is asserted as an EQUALITY, so it fails when the set grows as well
    // as when it shrinks — a new key must be a deliberate edit here.
    const keys = Object.keys(pageSchema?.properties ?? {}).sort();
    expect(
      keys,
      "the published schema's `page` properties changed. Add the new key to this expectation AND " +
        'to the validator in the same commit — a key the schema advertises and the server ignores ' +
        'is a field an author can set and nothing enforces.'
    ).toEqual(['buzzBudgetPerGen', 'fullBleed', 'icon', 'path', 'title']);

    const validatorSrc = read(VALIDATOR_PATH);
    for (const key of keys) {
      expect(
        validatorSrc,
        `the published schema declares \`page.${key}\` but ` +
          'src/server/services/block-manifest-validator.service.ts never names it, so submit ' +
          'validates nothing about it'
      ).toContain(`page.${key}`);
    }
  });

  it('🔴 the schema DESCRIPTION quotes the real cap — it is derived from APP_PAGE_MAX_WIDTH_PX', () => {
    const cap = appPageMaxWidthPx();
    expect(description.length, 'page.fullBleed has no description').toBeGreaterThan(0);
    expect(
      description,
      `the author-facing description does not mention the actual cap (${cap}px). It tells an ` +
        'author what they are opting out of, so a cap that moves without this prose moving leaves ' +
        'the published schema stating a false number to every App Block developer.'
    ).toContain(`${cap}px`);
  });

  it('🔴 every width the description calls UNAFFECTED is below the cap, and every AFFECTED one is above', () => {
    // The description's central promise is that declaring this field changes nothing
    // for ordinary displays. That promise is arithmetic over the cap, so it is
    // checkable — and it fails in BOTH directions, which is the point: raising the
    // cap past 1905 would falsify the "it binds on a 1080p monitor" claim just as
    // lowering it past 1536 would falsify the "nothing on a laptop" claim.
    const cap = appPageMaxWidthPx();

    // Widths named as classes where the field does nothing. Kept as literals rather
    // than parsed out of the prose: a parser over free text would quietly match
    // nothing and report a green.
    for (const width of [1280, 1366, 1440, 1536]) {
      expect(
        description,
        `the description no longer names the ${width}px laptop class it promises is unaffected`
      ).toContain(String(width));
      expect(
        width,
        `the description promises ${width}px is unaffected, but the cap is now ${cap}px — at or ` +
          'below that width the cap BINDS, so the promise is false'
      ).toBeLessThan(cap);
    }

    // …and the width it names as the point where the cap starts to bite must be above
    // the cap, or that sentence is false in the other direction.
    expect(
      description,
      'the description no longer names the ~1905px (maximised 1080p) viewport where the cap ' +
        'starts to bind — that is the honest statement of what this field costs an app that does ' +
        'NOT declare it, and the census argument for keeping the cap as the default rests on it'
    ).toContain('1905');
    expect(
      1905,
      `the description says the cap begins to bind at ~1905px, but the cap is now ${cap}px, which ` +
        'is wider — so it does not bind there at all'
    ).toBeGreaterThan(cap);
  });

  it('🔴 the description is pinned WHOLE — a guard on WORDS is walkable by rewording', () => {
    // An author reading this field is looking for how to turn it on. The sentence
    // that has to survive an edit is the one saying what happens if they do not —
    // because that is the behaviour every existing app has, and a description that
    // only explains the opt-in reads as though the cap were the new thing.
    //
    // The two substring checks below are kept AHEAD of the whole-string pin purely
    // as diagnostics: a whole-string pin goes red on ANY edit and so cannot tell a
    // reader WHICH claim they broke. Neither is the guard. Both were measured to
    // survive a meaning-inverting reword — see FULL_BLEED_DESCRIPTION's header.
    expect(
      description.toLowerCase(),
      'the description no longer says what OMITTING the field does. Declaring the opt-in without ' +
        'stating the default leaves an author guessing which behaviour is current.'
    ).toContain('omit it');
    expect(
      description,
      'the description no longer says the field is honoured by the full-page run host only. The ' +
        'model-slot surfaces impose no width cap, so an author declaring it for a slot block ' +
        'would be waiting for an effect that cannot arrive.'
    ).toMatch(/full-page run host only/i);

    // THE GUARD. Whitespace-normalised on both sides, so re-wrapping the JSON or the
    // copy above is free and NOTHING ELSE is.
    expect(
      norm(description),
      'THE PUBLISHED `page.fullBleed` DESCRIPTION CHANGED. This is a DELIBERATE verbatim pin of ' +
        'the whole string, not a substring sample: the substring checks above were measured to ' +
        "stay green through a reword that inverted the field's meaning while keeping every " +
        'number and both phrases, so only a whole-string pin makes this prose a checkable ' +
        'claim. THE ACCEPTED COST: a purely cosmetic edit — a typo fix, a re-punctuated clause ' +
        '— fails here too, and is paid by updating FULL_BLEED_DESCRIPTION in the SAME commit. ' +
        'Before you do that, read the diff as an author would: this text is what every App ' +
        'Block developer is told about their own layout. (Whitespace is normalised, so ' +
        're-wrapping either side is not what broke this.)'
    ).toBe(norm(FULL_BLEED_DESCRIPTION));
  });

  it('🔴 CONTROL — the cap extractor and the schema read can both FAIL', () => {
    // Every assertion above rests on two reads. A guard whose extractors cannot
    // return a wrong answer has only ever been watched to pass, so both are exercised
    // against inputs they must refuse.
    expect(() =>
      read(path.join(REPO_ROOT, 'public/schemas/app-block/v0-does-not-exist.json'))
    ).toThrow(/does not exist/);

    // The cap regex must not match prose ABOUT the constant — the failure mode where
    // a comment mentioning the name keeps a deleted declaration looking present.
    const decoy = '// export const APP_PAGE_MAX_WIDTH_PX is discussed here, value 9999\n';
    expect(/export const APP_PAGE_MAX_WIDTH_PX = (\d+);/.test(decoy)).toBe(false);

    // …and it must match the real declaration, with the real value. Without this the
    // line above is satisfied by a regex that matches nothing at all.
    const cap = appPageMaxWidthPx();
    expect(
      Number.isInteger(cap) && cap > 0,
      `the extracted cap is not a positive integer: ${cap}`
    ).toBe(true);
  });
});
