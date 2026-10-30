/** Parses RFC 4180 CSV (quoted fields, doubled quotes, embedded commas and newlines) into records keyed by the header row. */
export function parseCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;

  const endField = () => {
    row.push(field);
    field = '';
  };
  const endRow = () => {
    endField();
    if (row.length > 1 || row[0] !== '') rows.push(row);
    row = [];
  };

  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (source[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === ',') endField();
    else if (c === '\n') endRow();
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) endRow();

  const [header, ...body] = rows;
  if (!header) return [];
  return body.map((values) =>
    Object.fromEntries(header.map((name, index) => [name.trim(), values[index] ?? '']))
  );
}
