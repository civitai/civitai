// An unquoted value only parses if it is [A-Za-z0-9_.-] or non-ASCII letters, and the search client
// swallows the resulting 400 as an empty result set. Strings only: quoting a number changes it.
export function quoteMeiliValue(value: string) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}
