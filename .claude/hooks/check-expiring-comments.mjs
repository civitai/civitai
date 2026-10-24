#!/usr/bin/env node
// PostToolUse on Write|Edit, for src/ and the db-schema migrations.
//
// Catches a measurement written into a comment: a row count, a percentage, a dated "measured on".
// Those are true for about a minute and can never be corrected, because nobody re-reads an applied
// migration or a comment to update its numbers — and the same figures are already in docs/, dated
// and beside the query that produced them. `/cleanup` does not catch these: comment-review judges a
// survivor on fact density, and a measurement is a dense fact.
//
// Scans ONLY the text this call wrote, so the ~700 that already exist never fire it.

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let file;
  let written;
  try {
    const input = JSON.parse(raw || '{}');
    file = input.tool_response?.filePath ?? input.tool_input?.file_path ?? '';
    written = input.tool_input?.content ?? input.tool_input?.new_string ?? '';
  } catch {
    process.exit(0);
  }

  const path = file.replace(/\\/g, '/');
  const inScope =
    /\/src\//.test(path) || /\/packages\/civitai-db-schema\/prisma\/migrations\//.test(path);
  if (!inScope || !written) process.exit(0);

  const COMMENT = /^\s*(\/\/|--|\*|\/\*)/;
  // A grouped number (2,242) or a dated measurement. Deliberately narrow: a bare 500 is usually a
  // status code or a constant, and flagging those would get this hook switched off.
  const EXPIRING = [
    { re: /\b\d{1,3},\d{3}\b/, what: 'a measured count' },
    { re: /\b(measured|as of|verified)\b[^.]{0,40}\b\d{4}-\d{2}-\d{2}\b/i, what: 'a dated measurement' },
    { re: /\b\d+(\.\d+)?%\s*(of|de)\b/i, what: 'a measured percentage' },
  ];

  const hits = [];
  written.split('\n').forEach((line) => {
    if (!COMMENT.test(line)) return;
    for (const { re, what } of EXPIRING) {
      if (re.test(line)) {
        hits.push(`  ${what}: ${line.trim()}`);
        break;
      }
    }
  });

  if (!hits.length) process.exit(0);

  console.error(
    `A comment you just wrote states something that expires:\n\n${hits.join('\n')}\n\n` +
      `${path}\n\n` +
      `Move the figure to the doc that owns it, where it can carry a date and be corrected, and\n` +
      `leave the comment saying only what stays true — what the code does, or what an operator must\n` +
      `do. Nobody re-reads a comment to update its numbers, so a count here is wrong by next month\n` +
      `and misleading rather than merely stale.`
  );
  process.exit(2);
});
