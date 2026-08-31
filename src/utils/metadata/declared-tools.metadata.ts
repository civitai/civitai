export const MAX_METADATA_TOOL_COUNT = 10;
export const MAX_METADATA_TOOL_NAME_LENGTH = 80;
export const MAX_METADATA_TOOLS_JSON_LENGTH = 2048;

export function normalizeMetadataToolNames(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const names: string[] = [];
  const seen = new Set<string>();
  for (const item of value.slice(0, MAX_METADATA_TOOL_COUNT)) {
    if (typeof item !== 'string') continue;

    const name = item.trim();
    if (!name || name.length > MAX_METADATA_TOOL_NAME_LENGTH) continue;

    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names.length ? names : undefined;
}

export function parseMetadataToolNames(value: unknown): string[] | undefined {
  if (typeof value !== 'string') return normalizeMetadataToolNames(value);
  if (value.length > MAX_METADATA_TOOLS_JSON_LENGTH) return undefined;

  try {
    return normalizeMetadataToolNames(JSON.parse(value));
  } catch {
    return undefined;
  }
}

export function parseMetadataEngine(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const engine = value.trim();
  return engine && engine.length <= MAX_METADATA_TOOL_NAME_LENGTH ? engine : undefined;
}
