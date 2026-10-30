/**
 * Select-aware projection for `$queryRaw` fakes.
 *
 * WHY THIS EXISTS
 * ---------------
 * The obvious `$queryRaw` fake — `mock.mockResolvedValue([FIXTURE_ROW])` — returns the WHOLE
 * fixture row no matter what the statement's SELECT list asks for. A real database does not
 * do that: it returns exactly the selected columns. That infidelity makes a whole class of
 * test VACUOUS, and it is silent.
 *
 * Measured on the internal image-delivery lookup: a suite written to prove the query had
 * gained `type`/`mimeType` columns went GREEN against the pre-change service, which selects
 * neither. The service returned the fixture row it was handed, the fields were present
 * because the FIXTURE carried them, and the assertion could not tell the difference. Five
 * such assertions passed on code that did not implement them.
 *
 * WHAT IT DOES
 * ------------
 * Parses the SELECT list out of the tagged-template statement and narrows each fixture row to
 * those columns. A test that asserts on a column then genuinely depends on the production
 * statement selecting it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO
 * --------------------------------
 * It never falls back to pass-through. An unparseable statement and a fixture missing a
 * selected column both THROW, loudly and by name. A permissive fallback would restore exactly
 * the silent-vacuous-green this exists to remove: the one outcome worse than a red test is a
 * green one that proves nothing. If a fixture legitimately models "column present, value
 * absent", give the key an explicit `undefined` — the check is key PRESENCE, not definedness.
 */

/** The tagged-template first argument, as Prisma's `$queryRaw` receives it. */
type TemplateStrings = TemplateStringsArray | readonly string[];

const stripQuotes = (identifier: string) => identifier.replace(/^"(.*)"$/s, '$1');

/**
 * The column names a statement's SELECT list projects. `SELECT *` is reported as `'*'`.
 * `expr AS alias` reports the alias, since that is the key the row comes back under.
 */
export function selectedColumns(strings: TemplateStrings): string[] {
  // Interpolated values become bind parameters; the placeholder keeps the SQL well-formed.
  const sql = Array.from(strings).join(' $ ');
  const match = /\bSELECT\b([\s\S]*?)\bFROM\b/i.exec(sql);
  if (!match) {
    throw new Error(
      `queryRawProjection: could not find a SELECT ... FROM list in the statement, so the ` +
        `projection cannot be applied and the fake would silently return unselected columns. ` +
        `Statement was:\n${sql}`
    );
  }

  if (/^\s*\*\s*$/.test(match[1])) return ['*'];

  return match[1]
    .split(',')
    .map((column) => column.trim())
    .filter((column) => column.length > 0)
    .map((column) => {
      const aliased = /\bAS\s+("?[\w$]+"?)\s*$/i.exec(column);
      return stripQuotes(aliased ? aliased[1] : column);
    });
}

/**
 * Narrow `rows` to the columns the statement selects.
 *
 * Throws when a selected column is absent from a fixture row: that means the production
 * statement asks for something the fixture does not model, which would otherwise surface as a
 * quiet `undefined` in an assertion instead of a legible failure.
 */
export function projectOntoSelect<T extends Record<string, unknown>>(
  strings: TemplateStrings,
  rows: T[]
): Partial<T>[] {
  const columns = selectedColumns(strings);
  if (columns[0] === '*') return rows.map((row) => ({ ...row }));

  return rows.map((row, index) => {
    const projected: Partial<T> = {};
    for (const column of columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column)) {
        throw new Error(
          `queryRawProjection: statement selects "${column}" but fixture row ${index} has no ` +
            `such key (has: ${Object.keys(row).join(', ') || '<none>'}). Add the column to the ` +
            `fixture — an explicit \`undefined\` is fine if the point is that it has no value.`
        );
      }
      projected[column as keyof T] = row[column as keyof T];
    }
    return projected;
  });
}

/**
 * A `$queryRaw` mock implementation over a fixed result set, applying the projection above.
 *
 *     dbReadQueryRaw.mockImplementation(respondWithRows([IMAGE_ROW]));
 */
export function respondWithRows<T extends Record<string, unknown>>(rows: T[]) {
  return async (strings: TemplateStrings) => projectOntoSelect(strings, rows);
}
