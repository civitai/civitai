/**
 * What a remix clears, and what it keeps.
 *
 * `scope: 'active'` limits the clear to the family the remix is landing on, so the OTHER
 * families keep what the user chose there. Without it, a user who had OpenAI on v2.5 Sunburst
 * at medium, applied hires fix to an Illustrious image and switched back, found v2 at high.
 *
 * `ecosystem` and `workflow` are excluded because staging them is what makes the target family
 * active, which also makes THEM active addresses — the reset would otherwise take the ecosystem
 * with it. `denoise` is excluded for an unrelated reason: it describes the operation, not the
 * source image. A caller that means to replay either still wins, via the patch afterwards.
 *
 * Its own module, with no imports, so a unit test can bind to this object instead of restating
 * the list: `ingestion.ts` and `store.ts` both carry import graphs too heavy for a unit suite.
 */
export const REMIX_RESET = {
  exclude: ['quantity', 'priority', 'outputFormat', 'denoise', 'ecosystem', 'workflow'],
  scope: 'active',
} as const;
