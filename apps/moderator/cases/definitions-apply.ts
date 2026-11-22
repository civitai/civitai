/**
 * Prints the SQL that stores takedown request definitions as new versions. Read it, then apply it by
 * hand in each environment, like cases/schema.sql. Nothing here connects to a database.
 *
 *   pnpm exec tsx apps/moderator/cases/definitions-apply.ts <definitions.json> --actor <userId> [--enable k,k] [--commit]
 *
 * See definitionsSql for what it stores; without --commit the output is a dry run ending in ROLLBACK.
 */
import { readFileSync } from 'node:fs';
// Under tsx the workspace package loads as CommonJS, so its exports sit on `default`, not as named imports.
import * as moderation from '@civitai/moderation/process-definition';
import { definitionsSql } from '../src/lib/server/cases/definitions-sql';

const { processDefinitionSchema } =
  (moderation as unknown as { default?: typeof moderation }).default ?? moderation;

function arg(name: string) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const path = process.argv[2];
if (!path) {
  console.error(
    'usage: definitions-apply.ts <definitions.json> --actor <userId> [--enable k,k] [--commit]'
  );
  process.exit(2);
}
const { sql } = definitionsSql(readFileSync(path, 'utf8'), {
  schema: processDefinitionSchema,
  actor: Number(arg('--actor')),
  enable: (arg('--enable') ?? '').split(',').filter(Boolean),
  commit: process.argv.includes('--commit'),
});
console.log(sql);
