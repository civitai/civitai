import { readFileSync } from 'node:fs';

/**
 * The statements of a Prisma-vs-Kysely parity fixture, for `$executeRawUnsafe` (which sends one
 * prepared statement at a time).
 *
 * A naive split on `;` after dropping `--` comment lines. That is only safe for plain DDL with no
 * function bodies, no dollar-quoting and no semicolons inside literals or comments, which is what
 * every parity fixture is.
 */
export function loadParitySchema(path: string): string[] {
  return readFileSync(path, 'utf-8')
    .split(';')
    .map((statement) =>
      statement
        .split('\n')
        .filter((line) => !line.trim().startsWith('--'))
        .join('\n')
        .trim()
    )
    .filter(Boolean);
}
