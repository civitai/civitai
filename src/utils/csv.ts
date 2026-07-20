// Values starting with these are interpreted as formulas by Excel/Sheets, so a
// user-authored description could execute on open. Neutralize with a leading quote.
const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

function escapeCsvValue(value: unknown): string {
  if (value === null || value === undefined) return '';

  // Numbers bypass the formula guard — quoting a debit as '-500 would turn the
  // whole column into text and break summing it in a spreadsheet.
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);

  let str = value instanceof Date ? value.toISOString() : String(value);
  if (FORMULA_PREFIXES.some((prefix) => str.startsWith(prefix))) str = `'${str}`;
  if (/[",\n\r]/.test(str)) str = `"${str.replace(/"/g, '""')}"`;

  return str;
}

export function toCsvRows(rows: unknown[][]) {
  return rows.map((row) => row.map(escapeCsvValue).join(',')).join('\r\n');
}

export function toCsv(headers: string[], rows: unknown[][]) {
  return toCsvRows([headers, ...rows]);
}
