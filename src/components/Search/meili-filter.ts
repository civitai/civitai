// An unquoted value only parses if it is [A-Za-z0-9_.-] or non-ASCII letters, and the search client
// swallows the resulting 400 as an empty result set. Strings only: quoting a number changes it.
export function quoteMeiliValue(value: string) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

/**
 * Blank every quoted value in a filter expression, keeping the quotes so the surrounding
 * grammar still parses. The read half of the quoting grammar `quoteMeiliValue` writes — they
 * live together on purpose: a change to how values are quoted that is not mirrored here makes
 * a reader treat a value as syntax.
 *
 * A value is free text, so `user.username = 'a = b'` must not be read as a filter on `b`.
 */
export function stripQuotedMeiliValues(expression: string) {
  return expression.replace(/'(?:\\.|[^'\\])*'|"(?:\\.|[^"\\])*"/g, "''");
}
