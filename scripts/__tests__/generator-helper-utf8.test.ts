import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import { expect, it } from 'vitest';

/**
 * Prisma passes each generator its request as JSON lines on stdin, split by @prisma/generator-helper's
 * `byline`. It decoded every pipe chunk on its own, so a multi-byte character that straddled a chunk
 * boundary came out as U+FFFD, and the generated schema files differed by where the boundary fell
 * (patches/@prisma__generator-helper@*.patch). Both installed versions are checked.
 */

const require = createRequire(import.meta.url);

const versions = [
  // The root dependency, and prisma-kysely's copy.
  require.resolve('@prisma/generator-helper/dist/chunk-EOPVK4AE.js'),
  require.resolve('@prisma/generator-helper/dist/chunk-EOPVK4AE.js', {
    paths: [require.resolve('prisma-kysely/package.json')],
  }),
];

it.each(versions)('keeps a character split across two chunks whole (%s)', async (path) => {
  const { byline } = require(path) as { byline: (s: Readable) => NodeJS.ReadableStream };
  const bytes = Buffer.from('{"doc":"covered — never"}\n', 'utf8');
  const cut = bytes.indexOf(Buffer.from('—', 'utf8')) + 1; // inside the 3-byte dash
  const lines: string[] = [];
  await new Promise<void>((resolve, reject) => {
    byline(Readable.from([bytes.subarray(0, cut), bytes.subarray(cut)], { objectMode: false }))
      .on('data', (line: unknown) => lines.push(String(line)))
      .on('end', resolve)
      .on('error', reject);
  });
  expect(lines).toEqual(['{"doc":"covered — never"}']);
});
