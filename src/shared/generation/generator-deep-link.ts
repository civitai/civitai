/**
 * The form fields a `/generate?modelVersionId=…` link may preset, e.g.
 * `&resolution=2k&thinkingMode=ultra`. Plain option fields only: never the prompt, the model or
 * resources. Order matters: a field's options can depend on an earlier one (Krea 3 offers Ultra
 * only at 2K), so each is set after the ones before it.
 */
export const GENERATOR_DEEP_LINK_PARAMS = ['resolution', 'thinkingMode'] as const;

type GeneratorDeepLinkField = (typeof GENERATOR_DEEP_LINK_PARAMS)[number];
export type GeneratorDeepLinkFields = Partial<Record<GeneratorDeepLinkField, string>>;

const MAX_VALUE_LENGTH = 32;

/**
 * The allowlisted fields present in the link. Values are not checked against the model here: the
 * graph's own corrections send one the model does not offer (Ultra at 1K, a made-up resolution)
 * to a valid option, and a field the model lacks is ignored.
 */
export function generatorDeepLinkFields(params: URLSearchParams): GeneratorDeepLinkFields {
  const fields: GeneratorDeepLinkFields = {};
  for (const key of GENERATOR_DEEP_LINK_PARAMS) {
    const value = params.get(key)?.trim();
    if (value && value.length <= MAX_VALUE_LENGTH) fields[key] = value;
  }
  return fields;
}

/** Writes the fields one at a time, in allowlist order. Call it after the model has loaded. */
export function applyGeneratorDeepLinkFields(
  store: { set: (values: Record<string, unknown>) => void },
  fields: GeneratorDeepLinkFields
) {
  for (const key of GENERATOR_DEEP_LINK_PARAMS) {
    const value = fields[key];
    if (value !== undefined) store.set({ [key]: value });
  }
}
