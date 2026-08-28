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
  projectModelForTool,
  type ProjectedModel,
} from '~/server/services/blocks/tools/registry';
import { AIR_URN_PREFIX, containsAirReference } from '~/server/services/blocks/steps';
import {
  chatCompletionStep,
  MAX_MESSAGE_CHARS,
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
    // The name must satisfy the chat step's own tool-name pattern, or a block
    // could never declare it in the first place.
    for (const name of BLOCK_TOOL_NAMES) {
      expect(name).toMatch(/^[a-zA-Z0-9_-]+$/);
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
