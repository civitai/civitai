import { describe, it, expect } from 'vitest';
import * as z from 'zod';

import {
  AIR_URN_PREFIX_LOCAL,
  BLOCK_TOOL_NAMES,
  blockToolDeclarations,
  boundToolResult,
  getBlockTool,
  MAX_TOOL_RESULT_CHARS,
  MAX_TOOL_RESULT_ITEMS,
  neutralizeAirLiterals,
  NEUTRALIZE_DEPTH_PLACEHOLDER,
  projectModelForTool,
  type ProjectedModel,
} from '~/server/services/blocks/tools/registry';
import { AIR_URN_PREFIX, containsAirReference } from '~/server/services/blocks/steps';
import {
  chatCompletionStep,
  MAX_MESSAGE_CHARS,
  TOOL_NAME_PATTERN,
} from '~/server/services/blocks/steps/chat-completion.step';

/**
 * Unit tests for the App Blocks read-only tool registry (#398 AC5).
 *
 * The module under test is server-import-free by design, so these run without a
 * Prisma client. The ROUTE wiring (clamp, rate limit, dispatch) is covered in
 * `src/tests/api/v1/blocks/tools-endpoint.test.ts`.
 */

/**
 * A raw `runModelSearch` row, shaped after the real one.
 *
 * 🔴 IT CARRIES AIRs, FILES, HASHES AND DOWNLOAD URLS ON PURPOSE. A fixture
 * that never contained those could not tell an allowlist projection from a
 * passthrough — every "the projection does not leak X" assertion would pass
 * vacuously. The positive control below asserts the fixture really does contain
 * the thing the projection is supposed to remove.
 */
function rawSearchRow(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 4384,
    name: 'DreamShaper',
    type: 'Checkpoint',
    nsfw: false,
    tags: ['photorealistic', 'woman', 'base model', 'portraits', 'art style', 'a', 'b', 'c', 'd'],
    creator: { username: 'Lykon', image: 'https://example.invalid/avatar.png' },
    stats: { downloadCount: 1_700_000, thumbsUpCount: 42, favoriteCount: 7 },
    modelVersions: [
      {
        id: 128713,
        name: '8',
        baseModel: 'SD 1.5',
        air: 'urn:air:sd1:checkpoint:civitai:4384@128713',
        files: [
          {
            id: 1,
            name: 'dreamshaper.safetensors',
            hashes: { SHA256: 'deadbeef'.repeat(8) },
            downloadUrl: 'https://civitai.com/api/download/models/128713',
          },
        ],
        images: [{ id: 9, url: 'https://example.invalid/img.jpeg', nsfwLevel: 1 }],
      },
      {
        id: 252914,
        name: '7',
        baseModel: 'SD 1.5',
        air: 'urn:air:sd1:checkpoint:civitai:4384@252914',
        files: [],
        images: [],
      },
    ],
    ...over,
  };
}

describe('block tool registry — the allowlist', () => {
  it('registers exactly the read-only catalog tools, and every name is chat-tool legal', () => {
    expect(BLOCK_TOOL_NAMES).toEqual(['search_models']);
    // 🔴 THE PATTERN IS IMPORTED, NOT RE-SPELLED, and this assertion is the only
    // thing standing between a registered tool name and a wire schema that would
    // reject it. `tools.ts` validates the POSTed `name` against this same
    // `TOOL_NAME_PATTERN`. With a local copy of the regex, a future tightening of
    // the real pattern would make a registered tool unreachable over POST while
    // GET happily kept declaring it — and this test would stay green, because it
    // would be checking the old shape.
    for (const name of BLOCK_TOOL_NAMES) {
      expect(name).toMatch(TOOL_NAME_PATTERN);
    }
  });

  it('resolves a registered tool', () => {
    expect(getBlockTool('search_models')?.name).toBe('search_models');
  });

  it('🔴 rejects an unregistered name', () => {
    expect(getBlockTool('delete_everything')).toBeUndefined();
  });

  it('🔴 rejects PROTOTYPE keys — the null-prototype map is the control', () => {
    // With a plain object literal these resolve to Object.prototype members,
    // which are TRUTHY, so an `if (!tool) reject` guard would fail OPEN and
    // dispatch on an inherited function.
    for (const key of ['toString', 'constructor', 'hasOwnProperty', '__proto__', 'valueOf']) {
      expect(getBlockTool(key), `prototype key '${key}' must not resolve`).toBeUndefined();
    }
  });

  it('POSITIVE CONTROL — the same lookup DOES resolve a real name', () => {
    // Without this, "everything returns undefined" would also pass the case
    // above, including a lookup wired to nothing.
    expect(getBlockTool('search_models')).toBeDefined();
  });
});

describe('block tool registry — the argument contract is strict', () => {
  const tool = getBlockTool('search_models')!;

  it('accepts a valid argument object', () => {
    const parsed = tool.argsSchema.safeParse({ query: 'DreamShaper checkpoint', limit: 3 });
    expect(parsed.success).toBe(true);
  });

  it('🔴 rejects an UNKNOWN key rather than dropping it', () => {
    const parsed = tool.argsSchema.safeParse({ query: 'x', nsfw: true });
    expect(parsed.success).toBe(false);
  });

  it('🔴 rejects a maturity-shaped key specifically — the clamp is not negotiable', () => {
    // The tool schema deliberately carries no maturity field at all, so there is
    // nothing for a caller to set and nothing for the handler to ignore.
    for (const key of ['browsingLevel', 'nsfw', 'maxBrowsingLevel']) {
      expect(tool.argsSchema.safeParse({ query: 'x', [key]: 31 }).success).toBe(false);
    }
  });

  it('rejects a missing query, an empty query, and an over-cap limit', () => {
    expect(tool.argsSchema.safeParse({}).success).toBe(false);
    expect(tool.argsSchema.safeParse({ query: '' }).success).toBe(false);
    expect(
      tool.argsSchema.safeParse({ query: 'x', limit: MAX_TOOL_RESULT_ITEMS + 1 }).success
    ).toBe(false);
  });
});

describe('block tool registry — the model is shown the schema the route enforces', () => {
  it('🔴 `parameters` is DERIVED from the same argsSchema, not a hand-written twin', () => {
    const declared = blockToolDeclarations();
    expect(declared).toHaveLength(BLOCK_TOOL_NAMES.length);

    for (const entry of declared) {
      const tool = getBlockTool(entry.function.name)!;
      const derived = z.toJSONSchema(tool.argsSchema, { io: 'input', unrepresentable: 'any' });
      // Identity, not "looks similar": the served document must BE the
      // projection of the enforcing schema. A hand-written twin is how a model
      // gets shown a contract the route does not enforce.
      expect(entry.function.parameters).toEqual(derived);
    }
  });

  it('the declaration is shaped as the chat step accepts it', () => {
    // A declaration a block cannot actually pass to `tools[]` is useless, so
    // pin it against the step's own param schema rather than by eye.
    const parsed = chatCompletionStep.paramSchema.safeParse({
      model: 'openai/gpt-4o-mini',
      messages: [{ role: 'user', content: 'which checkpoint should I use?' }],
      maxTokens: 256,
      tools: blockToolDeclarations(),
    });
    expect(parsed.success).toBe(true);
  });
});

describe('block tool registry — projection is an ALLOWLIST', () => {
  it('keeps only the fields a chat model needs', () => {
    const projected = projectModelForTool(rawSearchRow())!;
    expect(projected).toEqual({
      id: 4384,
      name: 'DreamShaper',
      type: 'Checkpoint',
      baseModel: 'SD 1.5',
      creator: 'Lykon',
      downloads: 1_700_000,
      tags: ['photorealistic', 'woman', 'base model', 'portraits', 'art style', 'a', 'b', 'c'],
      url: 'https://civitai.com/models/4384',
    });
  });

  it('🔴 drops files, hashes, download urls and image urls — POSITIVE CONTROL first', () => {
    const raw = rawSearchRow();
    const rawJson = JSON.stringify(raw);
    // POSITIVE CONTROL: the fixture really does carry each thing, so the
    // assertions below are not vacuous.
    expect(rawJson).toContain('safetensors');
    expect(rawJson).toContain('SHA256');
    expect(rawJson).toContain('/api/download/models/');
    expect(rawJson).toContain('img.jpeg');

    const projectedJson = JSON.stringify(projectModelForTool(raw));
    expect(projectedJson).not.toContain('safetensors');
    expect(projectedJson).not.toContain('SHA256');
    expect(projectedJson).not.toContain('/api/download/models/');
    expect(projectedJson).not.toContain('img.jpeg');
  });

  it('returns null for a row missing an id or a name rather than a half-row', () => {
    expect(projectModelForTool(rawSearchRow({ id: undefined }))).toBeNull();
    expect(projectModelForTool(rawSearchRow({ name: '   ' }))).toBeNull();
    expect(projectModelForTool(null)).toBeNull();
    expect(projectModelForTool('not an object')).toBeNull();
  });
});

describe('🔴 block tool registry — AIR literals cannot reach a tool result', () => {
  it('🔴 POSITIVE CONTROL — the raw row DOES carry the literal the projection must remove', () => {
    // Without this the next assertion passes on any fixture that never had an
    // AIR, which is the both-wrong-blind shape: the test and the code agreeing
    // on a case neither has seen.
    const rawJson = JSON.stringify(rawSearchRow());
    expect(rawJson).toContain(AIR_URN_PREFIX_LOCAL);
    expect(rawJson.match(/urn:air:/gi)?.length).toBe(2);
  });

  it('🔴 the projected row carries NO air literal', () => {
    const projectedJson = JSON.stringify(projectModelForTool(rawSearchRow()));
    expect(projectedJson.toLowerCase()).not.toContain(AIR_URN_PREFIX_LOCAL);
  });

  it('🔴 an AIR in a USER-AUTHORED name is neutralised, not passed through', () => {
    // The allowlist alone does not cover this: `name` is a field we DO copy.
    const projected = projectModelForTool(
      rawSearchRow({ name: 'my urn:air:sd1:checkpoint:civitai:1@2 model' })
    )!;
    expect(projected.name).not.toContain('urn:air:');
    expect(projected.name).toContain('urn-air-');
  });

  it('🔴 the scrub is CASE-INSENSITIVE, because the scan it defends against is', () => {
    const scrubbed = neutralizeAirLiterals({ a: 'URN:AIR:x', b: ['UrN:aIr:y'] });
    expect(JSON.stringify(scrubbed).toLowerCase()).not.toContain('urn:air:');
  });

  it('🔴 the scrub covers object KEYS, not just values', () => {
    const scrubbed = neutralizeAirLiterals({ 'urn:air:sd1:checkpoint:civitai:1@2': 'v' });
    expect(Object.keys(scrubbed)[0]).not.toContain('urn:air:');
  });

  it('🔴 our local prefix constant matches the registry it defends against', () => {
    // The duplication is deliberate (keeping this module server-import-free);
    // this is what stops the two drifting.
    expect(AIR_URN_PREFIX_LOCAL).toBe(AIR_URN_PREFIX);
  });
});

describe('🔴 block tool registry — the ROUND TRIP actually closes', () => {
  it('a projected result survives containsAirReference AND the chat param schema', () => {
    const bounded = boundToolResult(
      [rawSearchRow(), rawSearchRow({ id: 5, name: 'urn:air: sneaky' })]
        .map((r) => projectModelForTool(r))
        .filter((m): m is ProjectedModel => m !== null)
    );
    const toolContent = JSON.stringify(bounded);

    // 1. The guard that would otherwise throw FORBIDDEN at submit.
    expect(containsAirReference({ content: toolContent })).toBe(false);

    // 2. The step's own param schema, with the result replayed as a tool message.
    const parsed = chatCompletionStep.paramSchema.safeParse({
      model: 'openai/gpt-4o-mini',
      messages: [
        { role: 'user', content: 'which checkpoint?' },
        {
          role: 'assistant',
          tool_calls: [
            {
              id: 'call_1',
              type: 'function',
              function: { name: 'search_models', arguments: '{"query":"dreamshaper"}' },
            },
          ],
        },
        { role: 'tool', content: toolContent, tool_call_id: 'call_1' },
      ],
      maxTokens: 256,
      tools: blockToolDeclarations(),
    });
    expect(parsed.success).toBe(true);
  });

  it('🔴 POSITIVE CONTROL — an UNPROJECTED result is refused by that same guard', () => {
    // Proves the round-trip case above is not passing because the guard is
    // inert: feed it the raw row and it must reject.
    const rawContent = JSON.stringify(rawSearchRow());
    expect(containsAirReference({ content: rawContent })).toBe(true);
  });
});

describe('block tool registry — the result is bounded so it can be replayed', () => {
  it('🔴 stays under the char budget, and the budget stays under the MESSAGE cap', () => {
    // The link that makes the budget meaningful: a result at or above
    // MAX_MESSAGE_CHARS cannot be replayed as a tool message at all.
    expect(MAX_TOOL_RESULT_CHARS).toBeLessThan(MAX_MESSAGE_CHARS);
  });

  it('🔴 the CHAR BUDGET binds before the item cap — drops whole rows, stays valid JSON', () => {
    // 🔴 THE FIXTURE MUST BE MAXIMAL, AND THAT IS THE WHOLE POINT OF THIS CASE.
    // An earlier version of this test used ordinary rows (~339 chars each), so
    // ten of them came to ~3,400 — under the 6,000 budget. The ITEM CAP was
    // doing all the work, the char-budget branch never executed, and deleting
    // that branch left the whole suite GREEN (mutant M7 survived). Measured, not
    // guessed: at 691 chars/row the budget binds at 8 rows (5,547 fits, 6,239
    // does not), which is strictly below MAX_TOOL_RESULT_ITEMS.
    const fatTag = (i: number) => `tag${i}`.padEnd(40, 'z');
    const fat = Array.from({ length: 40 }, (_, i) =>
      projectModelForTool(
        rawSearchRow({
          id: 1000 + i,
          name: `Model ${'x'.repeat(200)}`,
          type: 'TextualInversion',
          creator: { username: 'c'.repeat(60) },
          tags: [0, 1, 2, 3, 4, 5, 6, 7].map(fatTag),
          modelVersions: [{ id: 1, baseModel: 'Stable Diffusion XL 1.0' }],
        })
      )
    ).filter((m): m is ProjectedModel => m !== null);

    const bounded = boundToolResult(fat);
    const json = JSON.stringify(bounded);

    // 🔴 THE ISOLATING ASSERTION. Fewer than the item cap can ONLY happen if the
    // char budget stopped it — the item cap alone would have returned exactly
    // MAX_TOOL_RESULT_ITEMS. This is what kills M7.
    expect(bounded.items.length).toBeLessThan(MAX_TOOL_RESULT_ITEMS);
    expect(bounded.items.length).toBeGreaterThan(0);

    expect(JSON.stringify({ items: bounded.items }).length).toBeLessThanOrEqual(
      MAX_TOOL_RESULT_CHARS
    );
    expect(() => JSON.parse(json)).not.toThrow();
    expect(bounded.truncated).toBe(fat.length - bounded.items.length);
    // Every kept row is a COMPLETE row — the bound drops rows, never truncates.
    for (const item of bounded.items) {
      expect(item.id).toBeTypeOf('number');
      expect(item.url).toContain('/models/');
      expect(item.name.length).toBeGreaterThan(0);
    }
  });

  it('never returns more than the item cap even when rows are tiny', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({
      id: i,
      name: 'm',
      url: `https://civitai.com/models/${i}`,
    })) as ProjectedModel[];
    expect(boundToolResult(many).items.length).toBeLessThanOrEqual(MAX_TOOL_RESULT_ITEMS);
  });

  it('POSITIVE CONTROL — a small list is returned whole with nothing truncated', () => {
    // Without this, a bound that returned [] always would pass every case above.
    const small = [projectModelForTool(rawSearchRow())!];
    const bounded = boundToolResult(small);
    expect(bounded.items).toHaveLength(1);
    expect(bounded.truncated).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PER-FIELD LENGTH BOUNDS. Every one of these was uncovered: an audit widened
// each bound to 100000 and deleted `str()`'s truncation branch outright, and all
// four mutants SURVIVED — because every fixture in the file sat comfortably
// UNDER each bound, so the truncation never executed. The docstring's claim
// ("one pathological field cannot eat the budget") had zero coverage.
//
// 🔴 THE FIXTURES ARE NOT BUILT FROM THE CONSTANTS — an earlier version of this
// note claimed they were, and that was false in the shipped commit. They
// overshoot by a LITERAL (`OVERSHOOT` below) and a drift guard keeps them
// reaching. That is the deliberate choice, for the reason spelled out on
// `OVERSHOOT`: a constant-derived fixture moves WITH a widen-the-bound mutant
// and stops discriminating, which is how these came to be uncovered in the first
// place.
// ─────────────────────────────────────────────────────────────────────────────
describe('projectModelForTool — per-field length bounds', () => {
  // 🔴 THE EXPECTED LENGTHS ARE LITERALS, NOT THE CONSTANTS. A first version of
  // this block built both the fixture AND the expectation from the exported
  // constant — and all three widen-the-bound mutants SURVIVED, because widening
  // the constant moved the assertion with it. That is "never derive a test's
  // expectation from the implementation it tests", reproduced while fixing the
  // very gap it describes. A literal makes a retune a deliberate test edit.
  const OVERSHOOT = 400; // comfortably over every bound below

  it('🔴 truncates an over-long NAME to 120', () => {
    const p = projectModelForTool({ id: 1, name: 'N'.repeat(OVERSHOOT) }) as ProjectedModel;
    expect(p.name).toHaveLength(120);
    expect(p.name.endsWith('…')).toBe(true);
  });

  it('🔴 truncates an over-long CREATOR to 60', () => {
    const p = projectModelForTool({
      id: 1,
      name: 'ok',
      creator: { username: 'U'.repeat(OVERSHOOT) },
    }) as ProjectedModel;
    expect(p.creator).toHaveLength(60);
    expect(p.creator?.endsWith('…')).toBe(true);
  });

  it('🔴 truncates an over-long TAG to 40', () => {
    const p = projectModelForTool({
      id: 1,
      name: 'ok',
      tags: ['T'.repeat(OVERSHOOT)],
    }) as ProjectedModel;
    expect(p.tags?.[0]).toHaveLength(40);
    expect(p.tags?.[0].endsWith('…')).toBe(true);
  });

  it('🔴 truncates an over-long TYPE to 40', () => {
    const p = projectModelForTool({
      id: 1,
      name: 'ok',
      type: 'Y'.repeat(OVERSHOOT),
    }) as ProjectedModel;
    expect(p.type).toHaveLength(40);
    expect(p.type?.endsWith('…')).toBe(true);
  });

  it('🔴 truncates an over-long BASE MODEL to 40', () => {
    const p = projectModelForTool({
      id: 1,
      name: 'ok',
      modelVersions: [{ baseModel: 'B'.repeat(OVERSHOOT) }],
    }) as ProjectedModel;
    expect(p.baseModel).toHaveLength(40);
    expect(p.baseModel?.endsWith('…')).toBe(true);
  });

  // 🔴 ALL FIVE, not the three that were exported first. `type` and `baseModel`
  // were left as a bare `40` at their call sites while the other three were
  // converted, so an audit widened either to 100000 and the suite stayed green.
  // A bound that is a magic number at its call site cannot be reached by name.
  it('the literals above ARE the shipped constants (drift guard)', async () => {
    const m = await import('~/server/services/blocks/tools/registry');
    expect(m.MAX_PROJECTED_NAME_CHARS).toBe(120);
    expect(m.MAX_PROJECTED_CREATOR_CHARS).toBe(60);
    expect(m.MAX_PROJECTED_TAG_CHARS).toBe(40);
    expect(m.MAX_PROJECTED_TYPE_CHARS).toBe(40);
    expect(m.MAX_PROJECTED_BASE_MODEL_CHARS).toBe(40);
  });

  it('POSITIVE CONTROL — a field UNDER its bound is passed through untouched', () => {
    const exact = 'N'.repeat(120);
    const p = projectModelForTool({ id: 1, name: exact }) as ProjectedModel;
    // At exactly the bound there is nothing to cut, so no ellipsis — this is what
    // distinguishes "the bound is applied" from "every string is mangled".
    expect(p.name).toBe(exact);
    expect(p.name.endsWith('…')).toBe(false);
  });

  // 🔴 `slice` counts UTF-16 CODE UNITS. An astral character occupies two, so a
  // cut between them emits a LONE SURROGATE — valid JSON (`\udXXX`), nothing
  // throws, and the model just reads mojibake. Catalog names are user-authored
  // and routinely emoji-laden, so this is the ordinary case.
  const hasLoneSurrogate = (s: string) =>
    /[\ud800-\udbff](?![\udc00-\udfff])/.test(s) || /(?<![\ud800-\udbff])[\udc00-\udfff]/.test(s);

  it('🔴 never cuts through a surrogate pair', () => {
    const p = projectModelForTool({ id: 1, name: '🔥'.repeat(OVERSHOOT) }) as ProjectedModel;
    expect(p.name.length).toBeLessThanOrEqual(120);
    expect(hasLoneSurrogate(p.name)).toBe(false);
  });

  // 🔴 A PURE-ASTRAL FIXTURE CANNOT REACH HALF OF THE GUARD, and the case above
  // is pure astral. `str()` tests `charCodeAt(cut - 1)` against the HIGH range
  // `0xd800..0xdbff`; in an all-emoji string the high surrogates always land on
  // even indices, so that read is ALWAYS a high surrogate and the range's UPPER
  // bound never executes. An audit widened it to `0xdfff` — admitting LOW
  // surrogates, which retreats a unit that did not need retreating — and the
  // mutant SURVIVED the whole suite.
  //
  // One leading BMP character shifts the parity and makes the upper bound
  // load-bearing. Measured on this fixture: HEAD yields length 120 with no lone
  // surrogate; the widened mutant yields 119 ending in an orphaned high
  // surrogate. Same discrimination at the 40-char tag bound.
  //
  // The lesson generalises past this guard: a fixture whose constants put the
  // guarded branch exactly on its own boundary proves nothing about the branch.
  it('🔴 the surrogate RANGE is bounded on both ends — odd-parity astral input', () => {
    const shifted = `A${'🔥'.repeat(OVERSHOOT)}`;

    const p = projectModelForTool({ id: 1, name: shifted }) as ProjectedModel;
    expect(p.name).toHaveLength(120);
    expect(hasLoneSurrogate(p.name)).toBe(false);

    const t = projectModelForTool({ id: 1, name: 'ok', tags: [shifted] }) as ProjectedModel;
    expect(t.tags?.[0]).toHaveLength(40);
    expect(hasLoneSurrogate(t.tags?.[0] ?? '')).toBe(false);
  });

  // 🔴 NOT a JSON round-trip assertion. An earlier version asserted
  // `JSON.parse(JSON.stringify(name)) === name` under the comment "a lone
  // surrogate does not survive a JSON round trip intact". That comment is FALSE
  // — measured: ES2019 well-formed `JSON.stringify` escapes a lone surrogate as
  // `\udXXX` and `JSON.parse` restores it exactly, so the assertion held for
  // EVERY string and carried no information. It also contradicted the source
  // comment on `str()`, which correctly says the lone surrogate is valid JSON and
  // that the harm is mojibake rather than a serialization failure. The regex
  // checks above are what do the work.
  it('POSITIVE CONTROL — the detector fires on a deliberately broken string', () => {
    expect(hasLoneSurrogate('ab\ud83d')).toBe(true);
    expect(hasLoneSurrogate('ab\udd25')).toBe(true);
    expect(hasLoneSurrogate('ab🔥')).toBe(false);
  });
});

/**
 * Follow-ups from clawgate #426 — the couplings that were named but unpinned.
 */
describe('#426 — constants that must not drift', () => {
  it('🔴 item 3: the route bounds a tool name with the chat step\'s OWN constant', async () => {
    // The route used to spell `64` as a literal while `MAX_TOOL_NAME_CHARS` was
    // module-private. The values agreed only by inspection — the same drift the
    // neighbouring `.regex(TOOL_NAME_PATTERN)` had already closed by importing.
    const { MAX_TOOL_NAME_CHARS } = await import(
      '~/server/services/blocks/steps/chat-completion.step'
    );
    expect(typeof MAX_TOOL_NAME_CHARS).toBe('number');

    // Read the route's source and assert it does not re-spell the number.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(
      new URL('../../../../../pages/api/v1/blocks/tools.ts', import.meta.url),
      'utf8'
    );
    expect(
      src,
      'the wire `name` bound must be the imported constant, not a literal'
    ).toContain('.max(MAX_TOOL_NAME_CHARS)');
    expect(src).not.toMatch(/name:\s*z\.string\(\)\.min\(1\)\.max\(\d+\)/);
  });

  it('🔴 item 5: the DEFAULT the model is TOLD is the default the route APPLIES', async () => {
    // The declaration served to the model said "default 5" as a literal while
    // the route held its own `DEFAULT_LIMIT = 5`. Two copies of one number, and
    // the declaration is the model's only source of truth about the contract —
    // so a change to the route's default would leave the model confidently
    // misinformed, with nothing failing.
    const { DEFAULT_TOOL_RESULT_ITEMS } = await import(
      '~/server/services/blocks/tools/registry'
    );
    const decl = blockToolDeclarations().find((d) => d.function.name === 'search_models');
    expect(decl, 'search_models must be declared').toBeTruthy();

    const limitDesc = (
      decl!.function.parameters as { properties: { limit?: { description?: string } } }
    ).properties.limit?.description;
    expect(limitDesc, 'the limit parameter must carry a description').toBeTruthy();
    expect(
      limitDesc,
      'the declared default must be the constant the route applies'
    ).toContain(`default ${DEFAULT_TOOL_RESULT_ITEMS}`);

    // Positive control: the assertion above must be able to FAIL. A description
    // that named a different number must not satisfy it.
    expect(limitDesc).not.toContain(`default ${DEFAULT_TOOL_RESULT_ITEMS + 1}`);
  });
});

describe('#426 item 4 — neutralizeAirLiterals is depth-bounded', () => {
  /** Build `depth` levels of `{ a: { a: … { a: leaf } } }`. */
  function nest(depth: number, leaf: unknown): unknown {
    let out = leaf;
    for (let i = 0; i < depth; i += 1) out = { a: out };
    return out;
  }

  it('🔴 does not blow the stack on a deeply nested value', () => {
    // Pre-change this recursed without a budget. At ~5k levels — which a small
    // JSON body reaches trivially — that is a RangeError, i.e. a 500 from a
    // scrubber whose whole job is to make a 400 body safe to return.
    expect(() => neutralizeAirLiterals(nest(50_000, 'urn:air:leaf'))).not.toThrow();
  });

  it('🔴 the over-depth substitute carries NO caller content, so nothing survives unscrubbed', () => {
    // The fail direction is the opposite of `containsAirReference`'s. That is a
    // DETECTOR, so past its cap it returns TRUE (fail-closed). This is a
    // SCRUBBER: merely stopping the recursion would RETURN the over-deep
    // subtree untouched — fail-OPEN, the literal surviving because the input was
    // nested. So the cap substitutes a first-party constant instead.
    const scrubbed = neutralizeAirLiterals(nest(50_000, 'urn:air:deep-secret'));
    expect(JSON.stringify(scrubbed).toLowerCase()).not.toContain('urn:air:');
    expect(JSON.stringify(scrubbed)).toContain(NEUTRALIZE_DEPTH_PLACEHOLDER);
  });

  it('positive control: shallow values are still scrubbed normally, not replaced', () => {
    // Without this, a cap set to 0 would pass both tests above while destroying
    // the function's actual job.
    expect(neutralizeAirLiterals('see urn:air:model@1')).toBe('see urn-air-model@1');
    expect(neutralizeAirLiterals({ 'urn:air:k': ['urn:air:v'] })).toEqual({
      'urn-air-k': ['urn-air-v'],
    });
    expect(JSON.stringify(neutralizeAirLiterals(nest(10, 'urn:air:x')))).not.toContain(
      NEUTRALIZE_DEPTH_PLACEHOLDER
    );
  });
});
