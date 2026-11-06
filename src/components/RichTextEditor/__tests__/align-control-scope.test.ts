import { globSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The alignment button is an article-editor feature. Nothing else renders or asserts on the
// `includeControls` literal, so a dropped or leaked 'align' key would otherwise go unnoticed.
const files = globSync('src/**/*.tsx').filter(
  (f) => !f.includes('__tests__') && statSync(f).isFile()
);
const asksForAlign = files.filter((f) =>
  /includeControls=\{\[[^\]]*'align'/s.test(readFileSync(f, 'utf8'))
);

describe("includeControls 'align'", () => {
  it('is requested by the article editor and nothing else', () => {
    expect(asksForAlign).toEqual(['src/components/Article/ArticleUpsertForm.tsx']);
  });
});
