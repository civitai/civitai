/**
 * The accelerator LoRA kind a version is, for the models index's `versions.accelerator`. An
 * `accelerator` key, even null, decides; settings saved before it existed carry only a turbo block.
 */
export function getVersionAccelerator(settings: unknown): string | null {
  const s = settings as { accelerator?: string | null; turbo?: unknown } | null | undefined;
  if (s && 'accelerator' in s) return s.accelerator ?? null;
  return s?.turbo ? 'turbo' : null;
}
