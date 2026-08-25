import { describe, expect, it } from 'vitest';
import {
  modelVersionUpsertSchema,
  modelVersionUpsertSchema2,
} from '~/server/schema/model-version.schema';
import { baseModels } from '~/shared/constants/basemodel.constants';

// Both upsert schemas typed `baseModel` as a bare string, so the API stored whatever it was sent.
// Prod ended up with ecosystem keys ('Krea2'), casing variants ('ANIMA') and a literal '__bad__',
// each of which search then offered as its own filter option next to the real one.
const strays = ['Krea2', 'ANIMA', 'ACE-Step', 'Flux 1.0', 'Illustrious 0.1', 'Z-Image', '__bad__'];

const base = {
  modelId: 1,
  name: 'v1',
  trainedWords: [],
  images: [{ url: 'x', type: 'image' }],
};

const parse = (schema: { safeParse: (v: unknown) => { success: boolean } }, baseModel: string) =>
  schema.safeParse({ ...base, baseModel });

/**
 * Issues on `baseModel` alone. The fixture is deliberately not a complete valid version — other
 * fields may also complain, and asserting on overall success would pass for the wrong reason.
 */
function baseModelIssues(baseModel: string) {
  const result = modelVersionUpsertSchema2.safeParse({ ...base, baseModel });
  if (result.success) return [];
  return result.error.issues.filter((issue) => issue.path[0] === 'baseModel');
}

describe('modelVersionUpsertSchema baseModel', () => {
  // Named individually so a revert reports which value slipped through, not just a count.
  it.each(strays)('rejects the off-list value %s', (stray) => {
    expect(parse(modelVersionUpsertSchema, stray).success).toBe(false);
    expect(parse(modelVersionUpsertSchema2, stray).success).toBe(false);
  });

  it('names the rejected value in the error', () => {
    const result = modelVersionUpsertSchema2.safeParse({ ...base, baseModel: 'Krea2' });
    expect(result.success).toBe(false);
    if (result.success) return;
    const issue = result.error.issues.find((i) => i.path.join('.') === 'baseModel');
    expect(issue?.message).toBe('Unknown base model: Krea2');
  });

  // Positive control: without this, a schema that rejected EVERY string would pass the cases above.
  it.each(['Krea 2', 'Anima', 'ACE Audio', 'Flux.1 D', 'Illustrious', 'ZImageTurbo', 'SD 1.4'])(
    'accepts the canonical value %s',
    (name) => {
      expect(baseModels).toContain(name);
      expect(baseModelIssues(name)).toEqual([]);
    }
  );

  // The strays are only interesting while they are absent from the canonical list — if one is ever
  // added as a real name, the rejection cases above become wrong rather than merely redundant.
  it('keeps every stray out of the canonical list', () => {
    expect(strays.filter((s) => baseModels.includes(s))).toEqual([]);
  });
});
