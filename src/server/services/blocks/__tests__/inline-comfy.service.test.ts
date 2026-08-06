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
  INLINE_ALLOWED_AIR_SOURCES,
  INLINE_ALLOWED_AIR_TYPES,
  INLINE_NODEPACKS_ENABLED,
  inlineAirTypeRefusal,
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
  // ───────────────────────────────────────────────────────────────────────────
  // 🔴 NODEPACKS ARE OFF BECAUSE THE FLAG GRANTS THE WRONG SPELLING, NOT AS A
  // SAFETY POSTURE. #3663 flipped `INLINE_NODEPACKS_ENABLED` on and these cases
  // asserted the ACCEPT behaviour. Measured live against production afterwards:
  // a bare `comfy:nodepack` AIR passes this allowlist and is then 400'd by the
  // ORCHESTRATOR, which prescribes `comfy:nodepacklayer`. So the flag bought
  // nothing — it moved the failure one round-trip later, to a worse message.
  //
  // 🔴 THE LAYER SPELLING IS REFUSED BY US ALONE — NOT A DEADLOCK. The
  // orchestrator ACCEPTS `nodepacklayer` (its validator rejects only the bare
  // `nodepack`); civitai refuses it because it is in neither allowlist. Do not
  // read the cases below as "the other side is blocking us". See
  // `INLINE_NODEPACKS_ENABLED` for the sourced version of that claim and its
  // staleness marker.
  //
  // 🔴 INVERTED, NOT DELETED, IN EITHER DIRECTION. The coverage below is the
  // same shape it was when the flag was on, pointed the other way: the accept
  // path, the not-widened control, and the sibling-type control all still have a
  // case. Flipping the constant back is still one line — but not a free one: it
  // turns 9 cases red, by design, because they pin the refusal.
  // ───────────────────────────────────────────────────────────────────────────
  it('🔴 REJECTS a comfyregistry NODEPACK URN — the kill switch is off', async () => {
    expect(INLINE_NODEPACKS_ENABLED).toBe(false);
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0'],
        user: VIEWER,
      })
    ).rejects.toThrow(/nodepack resources are not permitted in an inline workflow/);
    // The belt is never reached — the shape gate rejects before any DB work.
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it("🔴 …and the message is the DEDICATED guard's, not the type allowlist's generic one", async () => {
    // MUTATION-DRIVEN. The nodepack guard and the type-allowlist guard are
    // adjacent, both throw BAD_REQUEST, and both messages end in the same
    // words. Delete the nodepack guard and a nodepack AIR is STILL rejected —
    // by the allowlist, with `resource AIR type 'nodepack' is not permitted`.
    // So a `/is not permitted in an inline workflow/` assertion would stay green
    // with the guard gone: it would be testing the sibling.
    //
    // This case names a token ONLY the dedicated guard emits, and asserts the
    // generic wording is ABSENT, so it dies when the guard does.
    const err = await assertViewerEntitledToInlineResources({
      airs: ['urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0'],
      user: VIEWER,
    }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain(
      'nodepack resources are not permitted in an inline workflow'
    );
    expect((err as Error).message).toContain('urn:air:comfy:nodepacklayer');
    expect((err as Error).message).toContain('ComfyNodepackSnapshot');
    expect((err as Error).message).not.toContain("resource AIR type 'nodepack' is not permitted");
  });

  it('🔴 the LAYER spelling the orchestrator prescribes takes the SAME informative refusal', async () => {
    // THE WHOLE POINT OF THE REVERT. Production 400s a bare pack AIR with
    // "Declare custom nodes as their install-layer AIR
    // (urn:air:comfy:nodepacklayer:…). Capture it with a ComfyNodepackSnapshot
    // step and use its output's layerAir." A developer who follows that advice
    // used to land on the type allowlist's bare `resource AIR type
    // 'nodepacklayer' is not permitted in an inline workflow` — a second,
    // differently-worded refusal with no way forward. Both spellings now get one
    // message that names which side refuses which, and says the layer form is
    // the one to build toward.
    const err = await assertViewerEntitledToInlineResources({
      airs: ['urn:air:comfy:nodepacklayer:comfyregistry:comfyui-kjnodes@1.0.0'],
      user: VIEWER,
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain(
      'nodepack resources are not permitted in an inline workflow'
    );
    expect((err as Error).message).not.toContain(
      "resource AIR type 'nodepacklayer' is not permitted"
    );
  });

  it('🔴 a civitai-sourced nodepack is rejected too, on the SAME guard', async () => {
    // With the flag ON this fixture reached the civitai entitlement branch and
    // was rejected fail-closed as an unresolvable model version — a different
    // guard, a different message. With the flag OFF the dedicated guard runs
    // first for EVERY source, so the refusal no longer depends on which source
    // happens to be spelled. Pinned because the old behaviour was subtle enough
    // to have its own test.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:other:nodepack:civitai:123@456'],
        user: VIEWER,
      })
    ).rejects.toThrow(/nodepack resources are not permitted in an inline workflow/);
    expect(mockGetResourceData).not.toHaveBeenCalled();
  });

  it('🔴 the revert did NOT narrow anything else — a non-nodepack resource is gated exactly as before', async () => {
    // The mirror of the test that guarded the flip. The failure it pins: a
    // revert that accidentally tightens (or loosens) the belt for the rest of
    // `resources`. A well-formed, generatable civitai LoRA plus a huggingface
    // weight must still be ACCEPTED, and a non-generatable one still REJECTED,
    // with nodepacks out of the picture entirely.
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR, HF_AIR], user: VIEWER })
    ).resolves.toBeUndefined();

    vi.clearAllMocks();
    mockGetResourceData.mockResolvedValue([resourceRow({ canGenerate: false })]);
    await expect(
      assertViewerEntitledToInlineResources({ airs: [LORA_AIR], user: VIEWER })
    ).rejects.toThrow(/not available for generation/);
  });

  it('🔴 COMFYREGISTRY is closed again as a SOURCE, and that is a separate guard from the type', async () => {
    // `comfyregistry` is in the source allowlist only while the flag is on. With
    // it off, a NON-nodepack AIR from comfyregistry — which slips past the
    // nodepack guard entirely — must be rejected by the SOURCE guard. This is
    // what proves the revert closed both halves, not just the loud one.
    const err = await assertViewerEntitledToInlineResources({
      airs: ['urn:air:comfy:lora:comfyregistry:kijai/whatever@1.0.0'],
      user: VIEWER,
    }).catch((e: Error) => e);
    expect((err as Error).message).toContain(
      "resource AIR source 'comfyregistry' is not permitted in an inline workflow"
    );
  });

  it('🔴 an OCI container-image AIR is rejected, on its OWN guard — unchanged by the revert', async () => {
    // `image` was never keyed off the nodepack flag in either direction. This is
    // the control that proves the revert narrowed one type, not the whole list.
    await expect(
      assertViewerEntitledToInlineResources({
        airs: ['urn:air:oci:image:ghcr:evil/comfy@v1'],
        user: VIEWER,
      })
    ).rejects.toThrow(/AIR type 'image' is not permitted in an inline workflow/);
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

// ─────────────────────────────────────────────────────────────────────────────
// MEMBERSHIP GUARD
//
// 🔴 READ THIS BEFORE TRUSTING THE BLOCK BELOW. It is NOT a contract test and it
// is NOT regression coverage. It is an INVARIANT GUARD — a change-detector that
// makes any edit to the two allowlists a deliberate, reviewed act instead of a
// silent one. It cannot fail because the orchestrator changed; it can only fail
// because WE changed.
//
// WHY NOT A REAL CONTRACT TEST. #3663's defect was a SEAM: civitai's allowlist
// and the orchestrator's accepted-AIR set are each individually correct and
// individually tested, and were broken only in combination. The fix for that
// class is to pin one side against a machine-generated artifact from the other.
// That artifact does not exist here. What was searched, and what was found:
//
//   • `@civitai/client@0.2.0-beta.84` (the GENERATED orchestrator client), all
//     46 files under `dist/`, greppable with `grep -a`. `types.gen.js` emits 67
//     runtime enums; NONE is an AIR type or AIR source enum. Every AIR-bearing field in
//     the entire generated surface — `CustomComfyInput.resources`,
//     `ResourceInfo.air`, `ComfyNodepackSnapshotInput.nodepacks`,
//     `ComfyNodepackSnapshotResult.layerAir` — is typed `string` or
//     `Array<string>`. There is nothing to pin against.
//   • `Air.parseSafe` (`dist/utils/Air.js`) is a bare regex; `type` and `source`
//     are `[a-zA-Z0-9_\-/]+` with no value validation at all.
//   • No vendored OpenAPI/JSON schema anywhere in the repo — `git ls-files |
//     grep -iE "openapi|swagger|\.schema\.json"` is empty, and the client ships
//     zero `.json` files. The spec lives in `civitai-client-javascript`, a
//     separate repo; this one holds only the published package.
//   • `src/shared/utils/air.ts`'s `typeUrnMap` is hand-written from civitai's
//     own Prisma `ModelType` enum. It is the EMIT direction (what we send), not
//     the ACCEPT direction, and `inline-comfy.service.ts` already documents why
//     deriving from it would be wrong.
//
// So the only in-repo statements about which AIRs the orchestrator accepts are
// JSDoc prose — and, as `inline-comfy.service.ts`'s header records, that prose
// CONTRADICTS ITSELF inside a single generated file. Pinning a constant against
// a docstring that is known-wrong would be worse than pinning nothing: it would
// look like a contract test and encode the stale half.
//
// WHAT THIS BLOCK THEREFORE DOES PROVE: that `INLINE_ALLOWED_AIR_TYPES` and
// `INLINE_ALLOWED_AIR_SOURCES` contain exactly the values written below, so
// widening either one cannot land without a reviewer seeing this file change.
// WHAT IT DOES NOT PROVE: anything whatsoever about what the orchestrator
// accepts. A divergence introduced by an orchestrator-side change stays
// invisible to CI, exactly as it was on 2026-08-05.
//
// WHAT WOULD MAKE A REAL CONTRACT TEST POSSIBLE (neither exists today): the
// orchestrator's OpenAPI JSON vendored here behind a re-vendor diff guard, or
// `@civitai/client` typing those fields as enums instead of `string`.
// ─────────────────────────────────────────────────────────────────────────────
describe('INVARIANT GUARD (not a contract test) — allowlist membership', () => {
  it('pins the exact AIR TYPE allowlist', () => {
    expect([...INLINE_ALLOWED_AIR_TYPES].sort()).toEqual(
      [
        'ag',
        'checkpoint',
        'clip',
        'clipvision',
        'controlnet',
        'diffusion_model',
        'diffusionmodel',
        'dora',
        'embedding',
        'hypernet',
        'lora',
        'lycoris',
        'motion',
        'text_encoders',
        'unet',
        'upscaler',
        'vae',
        'visionlanguage',
      ].sort()
    );
  });

  it('pins the exact AIR SOURCE allowlist', () => {
    expect([...INLINE_ALLOWED_AIR_SOURCES].sort()).toEqual(['civitai', 'huggingface'].sort());
  });

  it('records the CURRENT nodepack membership — a state, not a rule', () => {
    // 🔴 DELIBERATELY NOT PHRASED AS "nodepacklayer MUST NOT BE ALLOWED". An
    // earlier version of this case asserted exactly that, which would have made
    // the correct next step — allowlisting `nodepacklayer` — look like a
    // regression and put a red test in the way of the fix its own comment
    // prescribes. A change-detector must not moonlight as a policy.
    //
    // If you are here because you just permitted `nodepacklayer`: this line and
    // the two membership pins above are the ONLY places that need updating, and
    // the step-aside case below already proves the refusal path yields.
    expect(INLINE_ALLOWED_AIR_TYPES.has('nodepacklayer')).toBe(false);
    expect(INLINE_ALLOWED_AIR_TYPES.has('nodepack')).toBe(INLINE_NODEPACKS_ENABLED);
    expect(INLINE_ALLOWED_AIR_TYPES.has('image')).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 🔴 ANTI-SHADOWING. This is a RELATIONSHIP guard, not a membership one: it pins
// that the explanatory nodepack refusal YIELDS to the allowlist rather than
// pre-empting it. That ordering is load-bearing for a change nobody has made
// yet, which is exactly the kind of property that rots silently — the previous
// shape asked "is it a nodepack spelling AND is the flag off?" before consulting
// the allowlist, so permitting `nodepacklayer` would have been swallowed and
// reported as "nodepack resources are not permitted".
//
// `inlineAirTypeRefusal` takes the allowlist as a parameter precisely so this
// can be MEASURED on a synthetic set instead of asserted in a comment.
// ─────────────────────────────────────────────────────────────────────────────
describe('inlineAirTypeRefusal — the refusal must not shadow a future allowlisting', () => {
  const RAW_LAYER = 'urn:air:comfy:nodepacklayer:comfyregistry:kijai/comfyui-kjnodes@1.4.0';
  const RAW_PACK = 'urn:air:comfy:nodepack:comfyregistry:kijai/comfyui-kjnodes@1.4.0';

  it('refuses both spellings under the REAL allowlist, with the explanatory message', () => {
    expect(inlineAirTypeRefusal('nodepack', RAW_PACK)).toContain(
      'nodepack resources are not permitted in an inline workflow'
    );
    expect(inlineAirTypeRefusal('nodepacklayer', RAW_LAYER)).toContain(
      'nodepack resources are not permitted in an inline workflow'
    );
  });

  it('🔴 STEPS ASIDE the moment `nodepacklayer` is allowlisted — the whole point', () => {
    // The prescribed next step, simulated. If this returns a refusal, a
    // maintainer who permits the layer spelling gets told "nodepack resources
    // are not permitted" for a type they just permitted.
    const permissive = new Set([...INLINE_ALLOWED_AIR_TYPES, 'nodepacklayer']);
    expect(inlineAirTypeRefusal('nodepacklayer', RAW_LAYER, permissive)).toBeNull();
  });

  it('🔴 …and does NOT step aside for the bare pack in that same edit', () => {
    // The half that must survive: permitting the layer must not quietly permit
    // the bare URN, which the orchestrator refuses. Without this, the case above
    // is also satisfied by a function that returns null for anything.
    const permissive = new Set([...INLINE_ALLOWED_AIR_TYPES, 'nodepacklayer']);
    expect(inlineAirTypeRefusal('nodepack', RAW_PACK, permissive)).toContain(
      'nodepack resources are not permitted in an inline workflow'
    );
  });

  it('POSITIVE CONTROL — an already-allowed type returns null, a stranger gets the BARE message', () => {
    // Proves the function can return null at all (so the step-aside case is not
    // vacuously green), and that a non-nodepack type does NOT get the
    // explanatory message — the two branches are distinguishable.
    expect(inlineAirTypeRefusal('lora', 'urn:air:sdxl:lora:civitai:1@2')).toBeNull();
    const stranger = inlineAirTypeRefusal('image', 'urn:air:oci:image:ghcr:evil/comfy@v1');
    expect(stranger).toContain("resource AIR type 'image' is not permitted in an inline workflow");
    expect(stranger).not.toContain('nodepack resources are not permitted');
  });
});
