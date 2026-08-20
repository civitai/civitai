#!/usr/bin/env node
// PostToolUse on Write|Edit for .svelte files.
//
// Catches the one TypeScript-in-Svelte defect that NOTHING else in the loop sees: an optional
// parameter in a function signature. Svelte 5's TS stripping erases the type annotation but leaves
// the `?`, so rollup receives invalid JS — `pnpm build` fails while `typecheck`, the dev server and
// every review agent pass. Two of these reached a commit before anyone noticed (2026-08-10).
//
// A `?` inside a TYPE is fine (`{ reset: (id?: string) => void }`) — the whole annotation is erased.
// So this matches only a `?:` that follows an identifier directly inside a parameter list.

import fs from 'fs';

let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  let file;
  try {
    const input = JSON.parse(raw || '{}');
    file = input.tool_response?.filePath ?? input.tool_input?.file_path;
  } catch {
    process.exit(0);
  }
  if (!file || !file.endsWith('.svelte')) process.exit(0);

  let src;
  try {
    src = fs.readFileSync(file, 'utf8');
  } catch {
    process.exit(0);
  }

  // Only <script> blocks (a component may have two: instance and `module`); markup can contain anything.
  if (!/<script[^>]*>/.test(src)) process.exit(0);

  // A `?` inside a TYPE is fine — the whole annotation is erased. So the paren list must be in VALUE
  // position: after `function f`, after `=` (arrow assignment), or a method shorthand at line start.
  // `[^(){}]*?` is what does the real work: it refuses to cross a `{`, which is the only thing
  // separating `= (n?: number) =>` from `= (x as { flag?: T })`.
  const OPTIONAL_PARAM =
    /(?:function\s+[\w$]*\s*|=\s*(?:async\s+)?|^\s*(?:async\s+)?[\w$]+\s*)\(\s*[^(){}]*?\b[A-Za-z_$][\w$]*\?\s*:/;

  const hits = [];
  for (const block of src.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const startLine = src.slice(0, block.index).split('\n').length;
    block[1].split('\n').forEach((line, i) => {
      if (OPTIONAL_PARAM.test(line)) hits.push(`  line ${startLine + i}: ${line.trim()}`);
    });
  }

  if (!hits.length) process.exit(0);

  console.error(
    `Optional parameter in a .svelte function signature — this breaks \`pnpm build\` ONLY.\n` +
      `Svelte 5 strips the type annotation but leaves the \`?\`, and rollup rejects it. typecheck and\n` +
      `dev both pass, so nothing else in the loop will tell you.\n\n` +
      `${file}\n${hits.join('\n')}\n\n` +
      `Use a default (\`n = 0\`) or an explicit union (\`e: SubmitEvent | null = null\`).`
  );
  process.exit(2);
});
