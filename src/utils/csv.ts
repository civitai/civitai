// Values starting with these are interpreted as formulas by Excel/Sheets, so a
// user-authored description could execute on open. Neutralize with a leading quote.
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  let str = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_PREFIXES.some((prefix) => str.startsWith(prefix))) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;

  return str;
}

export function toCsv(headers: string[], rows: unknown[][]) {
  return [headers, ...rows].map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');
}
