import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { OWNER_MEDIA_EXEMPT_BLOCKS } from '~/server/common/image-block-marker';

// feed-go's OwnerMediaAllowedSQL (the twin of ownerMediaAllowedSql) inlines the exempt block reasons
// as SQL literals. It answers the thumbnail cache's misses, so a reason added to or dropped from
// OWNER_MEDIA_EXEMPT_BLOCKS without the Go list moving would serve (or withhold) a creator's blocked
// video thumbnail differently from Node.
const USERS_GO = join(__dirname, '../../apps/feed-go/internal/hydrate/users.go');

/** The quoted literals inside `IN (...)` of the Go OwnerMediaAllowedSQL function, or null. */
function goExemptBlocks(source: string): string[] | null {
  const fn = source.match(/func OwnerMediaAllowedSQL\(alias string\) string \{([\s\S]*?)\n\}/);
  if (!fn) return null;
  const list = fn[1].match(/IN \(([^)]*)\)/);
  if (!list) return null;
  return [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
}

describe('apps/feed-go OwnerMediaAllowedSQL', () => {
  it('inlines exactly OWNER_MEDIA_EXEMPT_BLOCKS', () => {
    const got = goExemptBlocks(readFileSync(USERS_GO, 'utf8'));
    expect(got).not.toBeNull();
    expect([...(got ?? [])].sort()).toEqual([...OWNER_MEDIA_EXEMPT_BLOCKS].sort());
  });

  // Positive control: the extraction reads a list it can tell apart from Node's.
  it('reads the literals out of the function, and sees a different list', () => {
    const fn = (list: string) =>
      `func OwnerMediaAllowedSQL(alias string) string {\n\treturn \`(CASE WHEN x IN (${list}) END)\`\n}\n`;
    expect(goExemptBlocks(fn(`'AiNotVerified'`))).toEqual(['AiNotVerified']);
    expect(goExemptBlocks(fn(`'AiNotVerified', 'Other'`))).toEqual(['AiNotVerified', 'Other']);
    expect(goExemptBlocks('func SomethingElse() {}\n')).toBeNull();
    expect(OWNER_MEDIA_EXEMPT_BLOCKS).toContain('AiNotVerified');
  });
});
