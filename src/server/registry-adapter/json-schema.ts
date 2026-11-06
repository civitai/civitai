import Ajv2020 from 'ajv/dist/2020';
import type { JsonSchema } from '~/server/registry-adapter/protocol';
import { ProtocolError } from '~/server/registry-adapter/protocol';

/**
 * A JSON Schema 2020-12 validator. `format` is an annotation here, as 2020-12 makes it by
 * default; unknown keywords (such as `x-successor`) are ignored rather than refused.
 */
export function newValidator() {
  return new Ajv2020({ strict: false, validateFormats: false, allErrors: false });
}

/** A request's `filter` as a predicate over bodies; `undefined` when there is none. */
export function compileFilter(
  filter: JsonSchema | undefined
): ((body: unknown) => boolean) | undefined {
  if (filter === undefined) return undefined;
  let validate: (body: unknown) => boolean;
  try {
    validate = newValidator().compile(filter) as (body: unknown) => boolean;
  } catch {
    throw new ProtocolError('bad_request', 'filter is not a valid JSON Schema');
  }
  return (body) => validate(body) === true;
}
