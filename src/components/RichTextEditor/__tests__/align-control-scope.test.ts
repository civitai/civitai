import { globSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Guards the `includeControls` literal: a dropped or leaked 'align' key is otherwise silent.
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
