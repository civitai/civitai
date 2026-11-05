import type { GenerationAspectRatio } from '~/shared/constants/generation.constants';
import type { RemixAppEngine } from '~/shared/constants/remix-apps.constants';

export type RemixImage = { url: string; width?: number; height?: number };

export type RemixAppSource = { imageId: number; url: string; width: number; height: number };

export const REMIX_UPSCALE_SCALES = [1.5, 2, 2.5, 3] as const;

/**
 * One workflow an app asks the host to run: an image generation on the app's engine, or an
 * upscale of one image. Plain orchestrator bodies are a later `kind` behind the same call.
 */
export type RemixWorkflowRequest =
  | {
      kind: 'image';
      prompt: string;
      images: RemixImage[];
      aspectRatio: 'source' | GenerationAspectRatio;
      quantity: 1 | 2 | 4;
    }
  | {
      kind: 'upscale';
      image: RemixImage;
      /** Capped by the upscaler's 4096px limit; the largest scale up to this that fits is used. */
      scale: (typeof REMIX_UPSCALE_SCALES)[number];
    };

export type RemixWorkflowResult = { workflowId: string; images: RemixImage[] };

export type RemixAsk =
  | { kind: 'choice'; prompt: string; options: { value: string; label: string }[] }
  | { kind: 'pick'; prompt: string; images: RemixImage[] }
  | { kind: 'text'; prompt: string; maxLength: number };

/** `choice` answers with an option's value, `pick` with an image index, `text` with the text. */
export type RemixAnswerOf<A extends RemixAsk> = A extends { kind: 'pick' } ? number : string;
export type RemixAnswer = string | number;

export type RemixCtx = {
  source: RemixAppSource;
  workflow(request: RemixWorkflowRequest): Promise<RemixWorkflowResult>;
  ask<A extends RemixAsk>(spec: A): Promise<RemixAnswerOf<A>>;
};

export type RemixApp = {
  slug: string;
  name: string;
  icon: string;
  description?: string;
  /** Bump when `run` changes what it asks for, so runs started on the old code are not replayed. */
  version: number;
  /** `mature` absent = the app refuses mature sources. */
  engine: { safe: RemixAppEngine; mature?: RemixAppEngine };
  /**
   * Must be deterministic over `ctx`: no clock, randomness or I/O outside `ctx`. The host re-runs
   * it from the start on every advance and feeds back the recorded results. Its first effect
   * must be a `workflow`; replay refuses an app that asks first.
   */
  run(ctx: RemixCtx): Promise<RemixImage[]>;
};

export function defineRemixApp(app: RemixApp): RemixApp {
  return app;
}
