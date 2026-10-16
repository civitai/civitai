import { describe, it, expect } from 'vitest';
import { getAllModelsSchema, modelsEndpointSchema } from '~/server/schema/model.schema';

/**
 * INVARIANT GUARD (not regression coverage — neither schema has ever had these keys).
 *
 * The block catalog's `owner=mine` restricts `getModelsRaw` by a user id taken from a verified
 * block token, passed as a SIBLING of `input` (`ownerUserId`). It must never become a field of
 * `getAllModelsSchema`: `/api/v1/models` parses `modelsEndpointSchema`, which extends it, straight
 * off `req.query`, so a field added there is a public query param.
 *
 * Checked on the parsed OUTPUT as well as the shape, so a `.passthrough()` / `.loose()` on either
 * schema is caught too.
 */
const KEYS = ['userId', 'ownerUserId'];

describe.each([
  ['getAllModelsSchema', getAllModelsSchema],
  ['modelsEndpointSchema', modelsEndpointSchema],
])('%s has no owner-id field', (_name, schema) => {
  it.each(KEYS)('declares no `%s`', (key) => {
    expect(Object.keys(schema.shape)).not.toContain(key);
  });

  it.each(KEYS)('drops a supplied `%s` from the parsed value', (key) => {
    const parsed = schema.parse({ [key]: '5529' });
    expect(parsed).not.toHaveProperty(key);
  });
});
