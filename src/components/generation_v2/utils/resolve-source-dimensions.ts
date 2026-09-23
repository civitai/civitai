export type Dimensions = { width: number; height: number };
type MaybeDimensions = { width?: number | null; height?: number | null } | null | undefined;

function toDimensions(value: MaybeDimensions): Dimensions | undefined {
  if (!value?.width || !value?.height) return undefined;
  return { width: value.width, height: value.height };
}

/**
 * Returns undefined when the image can't be loaded rather than a placeholder size:
 * the hires-fix graph derives its output size from these dimensions, so a guessed
 * 512x512 silently squares a portrait source and still charges for the result.
 */
export async function resolveSourceDimensions({
  cached,
  load,
}: {
  cached?: MaybeDimensions;
  load: () => Promise<MaybeDimensions>;
}): Promise<Dimensions | undefined> {
  return toDimensions(cached) ?? (await load().then(toDimensions, () => undefined));
}
