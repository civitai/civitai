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

// The same for Hugging Face resources, by lower-cased repo id.
const REFUSED_HF_REPOS: ReadonlySet<string> = new Set([
  'black-forest-labs/flux.2-klein-9b',
  'black-forest-labs/flux.2-klein-base-9b',
  'black-forest-labs/flux.2-klein-9b-kv-fp8',
  'black-forest-labs/flux.2-dev',
]);
// Every FLUX.1 "-dev" tool repo (Krea, Kontext, Fill, ...), but not FLUX.1-dev itself.
const REFUSED_HF_REPO_PATTERN = /^black-forest-labs\/flux\.1-.+-dev$/;

// The repo is the first two path segments; a file path may follow with or without `@<version>`.
const HF_AIR_RE = /^urn:air:[^:]+:[^:]+:huggingface:([^/@\s]+\/[^/@\s]+)/i;

export function isRefusedBaseModel(baseModel: string): boolean {
  return REFUSED_BASE_MODELS.has(baseModel);
}

export function isRefusedHfRepo(repoId: string): boolean {
  const id = repoId.trim().toLowerCase();
  return REFUSED_HF_REPOS.has(id) || REFUSED_HF_REPO_PATTERN.test(id);
}

/** The `org/repo` of a Hugging Face AIR, or null for any other AIR. */
export function hfRepoOfAir(air: string): string | null {
  return HF_AIR_RE.exec(air.trim())?.[1] ?? null;
}

/** Refuses a generation that would use a base model or Hugging Face repo no app may use. */
export function assertNoRestrictedBaseModels(opts: {
  baseModels?: readonly (string | null | undefined)[];
  airs?: readonly string[];
}): void {
  const refused =
    (opts.baseModels ?? []).some((m) => !!m && isRefusedBaseModel(m)) ||
    (opts.airs ?? []).some((air) => {
      const repo = hfRepoOfAir(air);
      return !!repo && isRefusedHfRepo(repo);
    });
  if (refused) {
    throw new TRPCError({
      code: 'FORBIDDEN',
      message: 'a selected resource is not available to apps',
    });
  }
}
