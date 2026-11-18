import { TRPCError } from '@trpc/server';

// Base models no app may generate with, Civitai's own included.
const REFUSED_BASE_MODELS: ReadonlySet<string> = new Set([
  'Flux.1 Krea',
  'Flux.2 D',
  'Flux.2 Klein 9B',
  'Flux.2 Klein 9B-base',
  'YuE2',
  'Ideogram 4.0',
]);

/** Refuses a generation that would use a base model no app may use. */
export function assertNoRestrictedBaseModels(opts: {
  baseModels: readonly (string | null | undefined)[];
}): void {
  if (opts.baseModels.some((m) => !!m && REFUSED_BASE_MODELS.has(m))) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'a selected resource is not available to apps',
    });
  }
}
