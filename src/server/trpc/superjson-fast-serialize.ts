import superjson from 'superjson';
import type { SuperJSONResult } from 'superjson';

// RED-BEFORE STUB (replaced in the next commit): the pre-change behaviour, superjson.serialize
// itself, so the tests run against what the code does today.
export function fastSuperjsonSerialize(object: unknown): SuperJSONResult {
  return superjson.serialize(object);
}
