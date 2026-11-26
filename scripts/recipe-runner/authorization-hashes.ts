/**
 * Prints the binding hashes for a recipe-runner run authorization (binding v1), the values to
 * pass to `v0-standing-authorization.sql` as `-v recipe_version_hash=` and `-v params_hash=`.
 *
 *   NODE_ENV=development pnpm exec tsx --env-file=.env scripts/recipe-runner/authorization-hashes.ts request.json
 *
 * `request.json` is what the runner will send: `{ "body": <customComfy body>, "runnerSlots": [...] }`,
 * with any example values in the slots (they are blanked before hashing). It uses the server's own
 * parse and hash, so a submit of that request matches.
 *
 * shortcut: inline arm only, where the ceiling is `maxBuzz` and the resources are the body's own.
 * A recipe-arm authorization needs the recipe's `budgetFor`; add it when a recipe declares
 * `runnerSlots`.
 */
import { readFileSync } from 'node:fs';
import { blockWorkflowBodySchema } from '~/server/schema/blocks/workflow.schema';
import {
  runnerBindingHashes,
  runnerSlotsSchema,
  type RunnerBindingBody,
} from '~/server/services/blocks/runner-binding';

const path = process.argv[2];
if (!path) {
  console.error('usage: authorization-hashes.ts <request.json>');
  process.exit(2);
}
const request = JSON.parse(readFileSync(path, 'utf8')) as { body?: unknown; runnerSlots?: unknown };
const body = blockWorkflowBodySchema.parse(request.body);
const slots = runnerSlotsSchema.parse(request.runnerSlots ?? []);
if (body.kind !== 'customComfy' || body.mode !== 'inline') {
  console.error('only an inline customComfy body is supported');
  process.exit(2);
}
const result = runnerBindingHashes(body as unknown as RunnerBindingBody, slots, {
  ceiling: body.maxBuzz,
  resources: body.resources,
});
if (!result.ok) {
  console.error(`refused: ${result.refusal}`);
  process.exit(1);
}
console.log(`recipe_version_hash=${result.hashes.recipeVersionHash}`);
console.log(`params_hash=${result.hashes.paramsHash}`);
// The server modules it imports hold Redis and flag clients open.
process.exit(0);
