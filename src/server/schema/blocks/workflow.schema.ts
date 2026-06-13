import * as z from 'zod';

// v1: textToImage is the only block-supported kind. Adding a new kind here
// must also (a) extend the discriminator in blocks.router workflow procedures,
// (b) be exposed by @civitai/app-sdk's useBuzzWorkflow contract.
//
// Caps are intentionally tighter than the platform-wide generateImageSchema —
// blocks run in untrusted iframes and the token issuer caps per-call buzz at
// BUZZ_BUDGET_CAP=1000, so wide-open quantity/dimensions wouldn't be honored
// anyway. Trim the surface area at the boundary instead of relying on
// downstream gates.

const PROMPT_MAX = 1500;
const NEG_PROMPT_MAX = 1500;
const DIM_MIN = 64;
const DIM_MAX = 2048;
const STEPS_MAX = 50;
const QUANTITY_MAX = 4;
const CLIP_SKIP_MAX = 12;

const blockTextToImageBodySchema = z.object({
  kind: z.literal('textToImage'),
  modelId: z.number().int().positive(),
  modelVersionId: z.number().int().positive(),
  params: z.object({
    prompt: z.string().max(PROMPT_MAX).default(''),
    negativePrompt: z.string().max(NEG_PROMPT_MAX).optional(),
    cfgScale: z.coerce.number().min(1).max(30).optional(),
    sampler: z.string().min(1).max(64).optional(),
    steps: z.coerce.number().int().min(1).max(STEPS_MAX).optional(),
    seed: z.coerce.number().int().nullish(),
    width: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
    height: z.coerce.number().int().min(DIM_MIN).max(DIM_MAX).optional(),
    // SD/SDXL per-resource convention. Flux ignores it. Cap at 12 (the
    // platform-wide constant in generation.constants.ts).
    clipSkip: z.coerce.number().int().min(0).max(CLIP_SKIP_MAX).optional(),
    quantity: z.coerce.number().int().min(1).max(QUANTITY_MAX).default(1),
  }),
});

export type BlockWorkflowBody = z.infer<typeof blockWorkflowBodySchema>;
export const blockWorkflowBodySchema = z.discriminatedUnion('kind', [blockTextToImageBodySchema]);

// Mirrors BlockWorkflowSnapshot in @civitai/app-sdk's blocks/types.ts.
// Keep field names in lockstep — this is the wire contract the iframe consumes.
//
// `autoClaim` is set when the host opportunistically claimed a Buzz reward
// on the user's behalf during submit (currently only `dailyBoost`). The block
// uses this to surface a "+25 daily boost claimed!" notice; it's purely
// informational, never carries state the block must reconcile.
export type BlockWorkflowSnapshot = {
  workflowId: string;
  status: 'pending' | 'processing' | 'succeeded' | 'failed' | 'expired' | 'canceled';
  cost?: { total: number };
  imageUrls?: string[];
  error?: string;
  autoClaim?: {
    type: 'dailyBoost';
    amount: number;
    accountType: 'yellow' | 'blue' | 'red' | 'green';
  };
};
