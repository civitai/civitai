import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockGetResourceData = vi.fn();
const mockGetHighestTierSubscription = vi.fn();

vi.mock('~/server/services/generation/generation.service', () => ({
  getResourceData: (...args: unknown[]) => mockGetResourceData(...args),
}));
vi.mock('~/server/services/subscriptions.service', () => ({
  getHighestTierSubscription: (...args: unknown[]) => mockGetHighestTierSubscription(...args),
}));

import {
  assertInlineGraphAirsDeclared,
  assertViewerEntitledToInlineResources,
  collectInlineAuditText,
  collectInlineGraphStrings,
  INLINE_NODEPACKS_ENABLED,
} from '~/server/services/blocks/inline-comfy.service';
import type { ComfyGraph } from '~/server/services/blocks/recipes';

/**
 * The inline-graph belt. This module is what REPLACES code review as the trust
 * root for an app-supplied ComfyUI graph, so the tests that matter here are the
 * ones for the failure modes a normal test plan omits — the ones that FAIL OPEN
 * silently rather than throwing.
 *
 * Every negative case below has a matched POSITIVE control on the same fixture,
 * because a negative alone cannot distinguish "the gate fired" from "the fixture
 * was rejected earlier for an unrelated reason".
 */

const LORA_AIR = 'urn:air:sdxl:lora:civitai:118025@136251';
const HF_AIR =
  'urn:air:zimageturbo:diffusion_model:huggingface:Comfy-Org/z_image_turbo@main/x.safetensors';
const VIEWER = { id: 7, isModerator: false };

function graph(over: ComfyGraph = {}): ComfyGraph {
  return {
    '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl.safetensors' } },
    '2': {
      class_type: 'CLIPTextEncode',
      inputs: { text: 'a serene mountain lake', clip: ['1', 1] },
    },
    ...over,
  };
}

/** A `getResourceData` row shaped like the real return (see generation.service). */
function resourceRow(over: Record<string, unknown> = {}) {
  return {
    id: 136251,
    name: 'a lora',
    canGenerate: true,
    availability: 'Public',
    air: LORA_AIR,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetResourceData.mockResolvedValue([resourceRow()]);
  mockGetHighestTierSubscription.mockResolvedValue(null);
});

describe('collectInlineGraphStrings — the walk', () => {
  it('collects leaves, array elements, object values AND object KEYS', () => {
    // Keys are walked because that is the orchestrator's own schema:
    // `additionalNetworks` is documented "Use the AIR of the network as the key".
    const found = collectInlineGraphStrings({
      a: 'leaf',
      b: ['inArray'],
      additionalNetworks: { [LORA_AIR]: { strength: 1 } },
    });
    expect(found).toContain('leaf');
    expect(found).toContain('inArray');
    expect(found).toContain(LORA_AIR); // the KEY
  });

  it('throws (never recurses to a stack overflow) past the depth cap', () => {
    let deep: unknown = 'bottom';
    for (let i = 0; i < 400; i++) deep = [deep];
    expect(() => collectInlineGraphStrings(deep)).toThrow(/nested too deeply/);
  });

  it('POSITIVE CONTROL — a legally-nested value does NOT throw', () => {
    let ok: unknown = 'bottom';
    for (let i = 0; i < 20; i++) ok = [ok];
    expect(() => collectInlineGraphStrings(ok)).not.toThrow();
  });
});

describe('assertInlineGraphAirsDeclared — containment', () => {
  it('rejects a graph naming an AIR that `resources` omits', () => {
    const g = graph({ '3': { class_type: 'LoraLoader', inputs: { lora_name: LORA_AIR } } });
    expect(() => assertInlineGraphAirsDeclared(g, [])).toThrow(/not declared in resources/);
  });

  it('accepts it once declared, case-insensitively', () => {
    const g = graph({ '3': { class_type: 'LoraLoader', inputs: { lora_name: LORA_AIR } } });
    expect(() => assertInlineGraphAirsDeclared(g, [LORA_AIR.toUpperCase()])).not.toThrow();
  });

  it('catches an AIR hidden in an object KEY, not just a value', () => {
    const g = graph({
      '3': { class_type: 'X', inputs: { additionalNetworks: { [LORA_AIR]: { strength: 1 } } } },
    });
    expect(() => assertInlineGraphAirsDeclared(g, [])).toThrow(/not declared in resources/);
    expect(() => assertInlineGraphAirsDeclared(g, [LORA_AIR])).not.toThrow();
  });

  it('rejects an AIR EMBEDDED in a longer string even when that AIR is declared', () => {
    // Whole-string match, deliberately. Extracting a URN out of a longer string
    // would mean maintaining a second copy of the AIR grammar, and any drift
    // between that copy and what the worker resolves is the bypass.
    const g = graph({
      '3': { class_type: 'X', inputs: { note: `see ${LORA_AIR} for details` } },
    });
    expect(() => assertInlineGraphAirsDeclared(g, [LORA_AIR])).toThrow(/not declared in resources/);
  });

  it('POSITIVE CONTROL — a graph with no AIR at all passes with no declarations', () => {
    expect(() => assertInlineGraphAirsDeclared(graph(), [])).not.toThrow();
  });
});

describe('collectInlineAuditText — the moderation sweep', () => {
  it('🔴 collects the prompt from inside a CLIPTextEncode node, not just the declared field', () => {
    // This is the whole point. On the recipe arm the audit reads a schema-owned
    // `params.prompt`. An inline graph carries prompts as leaf strings, so an
    // audit of the declared field alone would scan a value the generation never
    // uses — moderation becomes a silent no-op with every gate green.
    const text = collectInlineAuditText({
      prompt: 'a clean declared prompt',
      graph: graph({ '9': { class_type: 'CLIPTextEncode', inputs: { text: 'GRAPH_PROMPT_XYZ' } } }),
    });
    expect(text).toContain('GRAPH_PROMPT_XYZ');
    expect(text).toContain('a clean declared prompt');
  });

  it('dedupes repeated leaves (a graph repeats class names on every node)', () => {
    const text = collectInlineAuditText({
      prompt: '',
      graph: {
        '1': { class_type: 'CLIPTextEncode', inputs: { text: 'same' } },
        '2': { class_type: 'CLIPTextEncode', inputs: { text: 'same' } },
      },
    });
    expect(text.split('\n').filter((l) => l === 'same')).toHaveLength(1);
  });

  it('REJECTS rather than truncates when there is more text than can be moderated', () => {
    // Truncating would be a moderation bypass by construction: put the
    // disallowed text past the cutoff.
    const many = Object.fromEntries(
      Array.from({ length: 250 }, (_, i) => [
        String(i),
        { class_type: 'CLIPTextEncode', inputs: { text: `${i}-${'x'.repeat(200)}` } },
      ])
    ) as unknown as ComfyGraph;
    expect(() => collectInlineAuditText({ prompt: '', graph: many })).toThrow(
      /more text than can be moderated/
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AIR SHAPE GATE. Every case here is a MEASURED property of `Air.parseSafe`
// (@civitai/client 0.2.0-beta.84) that fails OPEN if the gate is naive.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertViewerEntitledToInlineResources — AIR shape', () => {
  it('🔴 rejects a NODEPACK URN while nodepacks are gated off (arbitrary code execution)', async () => {
    expect(INLINE_NODEPACKS_ENABLED).toBe(false);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0'],
        user: VIEWER,
      })
    ).rejects.toThrow(/nodepack resources are not permitted/);
  });

  it('rejects a nodepack from ANY source, not just comfyregistry', async () => {
    // The gate keys on the AIR `type`, not the source — a `civitai`-sourced
    // nodepack is the same capability.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:other:nodepack:civitai:123@456'],
        user: VIEWER,
      })
    ).rejects.toThrow(/nodepack resources are not permitted/);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 THE TYPE ALLOWLIST (`INLINE_ALLOWED_AIR_TYPES`) NEEDS AN ASSERTION ONLY
  // IT CAN SATISFY. `comfyImage` — an arbitrary OCI container the claiming
  // worker would run — is unsettable via the wire schema's `.strict()`; this
  // guard is what stops the same capability arriving through `resources`.
  //
  // The trap it was written out of: the type guard and the SOURCE guard sit two
  // lines apart and their messages share the tail `is not permitted in an inline
  // workflow`. A `/is not permitted in an inline workflow/` assertion is
  // therefore satisfied by EITHER — so deleting the type guard left the old
  // version of the first case below still green, because the fixture's `ghcr`
  // source then tripped the source guard instead. The two cases below fix that
  // from both directions: each names the token in ITS OWN guard's message, and
  // the second uses an ALLOWLISTED source so no sibling can stand in for it.
  // ───────────────────────────────────────────────────────────────────────────
  it('rejects an OCI container-image AIR arriving through `resources`', async () => {
    // MEASURED ORDER: the type guard runs BEFORE the source guard, so this
    // fixture is rejected on `type: image`, not on `source: ghcr`. Asserting the
    // type guard's own message is what makes this case die when that guard is
    // removed rather than falling through to the source guard's identical tail.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:oci:image:ghcr:evil/comfy@v1'],
        user: VIEWER,
      })
    ).rejects.toThrow(/AIR type 'image' is not permitted in an inline workflow/);
  });

  it('🔴 …and from an ALLOWLISTED source too, where NO sibling guard could mask it', async () => {
    // `huggingface` IS allowlisted, so the source guard cannot reject this AIR:
    // the type guard is the only thing standing between an app and an arbitrary
    // container image. Remove it and this case does not merely change its error
    // — it stops throwing at all.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:oci:image:huggingface:evil/comfy@v1'],
        user: VIEWER,
      })
    ).rejects.toThrow(/AIR type 'image' is not permitted in an inline workflow/);
  });

  it('POSITIVE CONTROL — the same AIR with an ALLOWLISTED type is accepted', async () => {
    // Isolates the `type` token as the cause: same source, same `oci` ecosystem,
    // same `evil/comfy@v1` id and version — only `image` → `lora` changes, and
    // the rejection goes away. Without this, the case above is also satisfied by
    // a guard that rejects every huggingface AIR for some unrelated reason.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:oci:lora:huggingface:evil/comfy@v1'],
        user: VIEWER,
      })
    ).resolves.toBeUndefined();
  });

  it('🔴 OVER-STRICTNESS CONTROL — accepts every AIR the SHIPPED recipes actually pin', async () => {
    // The strict reader is a second, deliberately narrower copy of the AIR
    // grammar. Its failure direction is safe (false reject, never false accept),
    // but a reader so strict it rejects the platform's own live AIRs is useless.
    // These are copied verbatim from `recipes/seamless-pano.recipe.ts` — note
    // the `/`-and-`.`-bearing huggingface versions and the underscored
    // `diffusion_model` / `text_encoders` types, all of which a naive
    // `[a-z0-9]+@\d+` reader would reject.
    const shipped = [
      'urn:air:zimageturbo:diffusion_model:huggingface:Comfy-Org/z_image_turbo@main/split_files/diffusion_models/z_image_turbo_bf16.safetensors',
      'urn:air:qwen:clip:huggingface:Comfy-Org/z_image_turbo@main/split_files/text_encoders/qwen_3_4b_fp8_mixed.safetensors',
      'urn:air:flux1:vae:huggingface:black-forest-labs/FLUX.1-dev@main/ae.safetensors',
      'urn:air:qwen:diffusion_model:huggingface:unsloth/Qwen-Image-2512-GGUF@main/qwen-image-2512-Q5_K_M.gguf',
      'urn:air:flux2:text_encoders:huggingface:Comfy-Org/vae-text-encorder-for-flux-klein-9b@main/split_files/text_encoders/qwen_3_8b_fp8mixed.safetensors',
      'urn:air:zimageturbo:lora:civitai:118025@2702227',
      'urn:air:qwen:lora:civitai:118025@2702222',
      'urn:air:flux2:lora:civitai:118025@2702214',
    ];
    mockGetResourceData.mockImplementation(async (ids: number[]) =>
      ids.map((id) => resourceRow({ id }))
    );
    await expect(
      assertViewerEntitledToInlineResources({ airs: shipped, user: VIEWER })
    ).resolves.toBeUndefined();
    expect(mockGetResourceData).toHaveBeenCalledWith(
      [2702227, 2702222, 2702214],
      expect.anything()
    );
  });

  it('🔴 rejects a PREFIX-LESS pseudo-AIR — a lenient reader accepts one', async () => {
    // Measured: its regex is `^(?:urn:)?(?:air:)?…`, so 'sdxl:lora:civitai:1@2'
    // parses and even 'foo:bar' parses as {source:'foo', id:'bar'}. parseSafe
    // returning a value is NOT evidence the string is an AIR.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['sdxl:lora:civitai:118025@136251'],
        user: VIEWER,
      })
    ).rejects.toThrow(/is not an AIR URN/);
    await expect(
      assertViewerEntitledToInlineResources({ airs: ['foo:bar'], user: VIEWER })
    ).rejects.toThrow(/is not an AIR URN/);
  });

  it('🔴 an UPPERCASE `CIVITAI` source is still gated, not routed around the belt', async () => {
    // Measured: `source` is case-preserving. A case-SENSITIVE
    // `source === 'civitai'` test would send this down the non-civitai branch
    // and skip entitlement entirely — a direct bypass.
    mockGetResourceData.mockResolvedValue([resourceRow({ canGenerate: false })]);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:sdxl:lora:CIVITAI:118025@136251'],
        user: VIEWER,
      })
    ).rejects.toThrow(/not available for generation/);
    // The belt was actually consulted, with the parsed version id.
    expect(mockGetResourceData).toHaveBeenCalledWith([136251], expect.anything());
  });

  it('🔴 rejects a civitai AIR with no version, or a non-numeric one', async () => {
    // Measured: `version` is an optional RAW STRING. `Number(undefined)` and
    // `Number('def')` are both NaN, and a NaN id resolves nothing — which, via
    // getResourceData's silent-drop, would look like "no gated resources here".
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:sdxl:lora:civitai:118025'],
        user: VIEWER,
      })
    ).rejects.toThrow(/must name a model VERSION id/);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:sdxl:lora:civitai:abc@def'],
        user: VIEWER,
      })
    ).rejects.toThrow(/must name a model VERSION id/);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('rejects a duplicate declaration rather than silently deduping', async () => {
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR, LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/duplicate resource declared/);
  });

  it('a huggingface-only manifest needs no civitai belt call (exempt by construction)', async () => {
    await expect(
      assertViewerEntitledToInlineResources({ airs: [HF_AIR], user: VIEWER })
    ).resolves.toBeUndefined();
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('POSITIVE CONTROL — a well-formed civitai AIR for a generatable resource passes', async () => {
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR, HF_AIR], user: VIEWER })
    ).resolves.toBeUndefined();
    expect(mockGetResourceData).toHaveBeenCalledWith([136251], expect.anything());
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 THE TWO SILENT FAIL-OPENS. Both are cases where a checker that iterates the
// RETURNED array and asserts `canGenerate` passes VACUOUSLY. These are the two
// tests a normal plan omits, and they are the entire reason this belt is a
// dedicated function rather than a call to getResourceData.
// ─────────────────────────────────────────────────────────────────────────────
describe('assertViewerEntitledToInlineResources — the silent fail-opens', () => {
  it('🔴 ANTI-DROP: an id getResourceData silently drops is a REJECT, not an implicit allow', async () => {
    // getResourceData does `if (!cached) return null` then `.filter(isDefined)`,
    // so an unresolvable id simply is not in the result. "No bad resources in
    // the array" is trivially true of an empty array.
    mockGetResourceData.mockResolvedValue([]);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/model version 136251 is not available for generation/);
  });

  it('🔴 ANTI-DROP holds when only SOME of several ids come back', async () => {
    mockGetResourceData.mockResolvedValue([resourceRow({ id: 136251 })]);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: [LORA_AIR, 'urn:air:sdxl:lora:civitai:118025@999999'],
        user: VIEWER,
      })
    ).rejects.toThrow(/model version 999999 is not available for generation/);
  });

  it('🔴 ANTI-SUBSTITUTE: a resource carrying a `substitute` is a REJECT, never a swap', async () => {
    // getResourceDataSubstitutes swaps an uncovered/inaccessible version for a
    // covered sibling of the same model and attaches it as `resource.substitute`.
    // Onsite that is graceful degradation; here the graph names ONE specific AIR
    // string in `lora_name` and nothing rewrites the graph — running a different
    // version silently is a correctness bug.
    //
    // Note the returned row KEEPS the requested id (the substitute is a sibling
    // FIELD, not a replacement element), so an anti-drop check alone does not
    // catch this — which is why `canGenerate` is left TRUE in this fixture.
    mockGetResourceData.mockResolvedValue([
      resourceRow({ canGenerate: true, substitute: { id: 999999, name: 'other version' } }),
    ]);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/never silently substituted/);
  });

  it('rejects a resource whose canGenerate is false', async () => {
    mockGetResourceData.mockResolvedValue([resourceRow({ canGenerate: false })]);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/not available for generation/);
  });

  it('EARLY ACCESS is covered, because getResourceData folds applyPaidAccessGating', async () => {
    // applyPaidAccessGating sets `canGenerate = hasAccess && canGenerate`, so a
    // non-entitled viewer of an early-access version comes back canGenerate:false.
    // This pins that the belt READS that flag rather than re-deriving a weaker one.
    mockGetResourceData.mockResolvedValue([
      resourceRow({
        canGenerate: false,
        hasAccess: false,
        paidAccess: { endsAt: null, terms: {} },
      }),
    ]);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/not available for generation/);
  });
});

describe('assertViewerEntitledToInlineResources — Private / epoch subscription', () => {
  it('rejects a Private resource for a viewer with no subscription', async () => {
    mockGetResourceData.mockResolvedValue([resourceRow({ availability: 'Private' })]);
    mockGetHighestTierSubscription.mockResolvedValue(null);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/requires an active subscription/);
  });

  it('POSITIVE CONTROL — the same resource passes for a subscriber', async () => {
    mockGetResourceData.mockResolvedValue([resourceRow({ availability: 'Private' })]);
    mockGetHighestTierSubscription.mockResolvedValue({ id: 'sub_1' });
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).resolves.toBeUndefined();
  });

  it('an EPOCH resource takes the same subscription path', async () => {
    mockGetResourceData.mockResolvedValue([
      resourceRow({ epochDetails: { epochNumber: 3, isExpired: false } }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue(null);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/requires an active subscription/);
  });

  it('an EXPIRED epoch is rejected even for a subscriber', async () => {
    mockGetResourceData.mockResolvedValue([
      resourceRow({ epochDetails: { epochNumber: 3, isExpired: true } }),
    ]);
    mockGetHighestTierSubscription.mockResolvedValue({ id: 'sub_1' });
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/epoch that has expired/);
  });

  it('a moderator skips the subscription requirement', async () => {
    mockGetResourceData.mockResolvedValue([resourceRow({ availability: 'Private' })]);
    mockGetHighestTierSubscription.mockResolvedValue(null);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: [LORA_AIR],
        user: { id: 7, isModerator: true },
      })
    ).resolves.toBeUndefined();
    expect(mockGetHighestTierSubscription).not.toHaveBeenCalled();
  });
});
