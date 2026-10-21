import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HASH_FAIL_COUNT_SQL,
  VALID_OVERRIDE_SQL,
} from '~/server/services/bounty-entry-file-check.service';

const MODERATOR_SERVICE = join(
  process.cwd(),
  'apps/moderator/src/lib/server/bounty-file-check.service.ts'
);
const squash = (sql: string) => sql.replace(/\s+/g, ' ').trim();

/** The body of `const <name> = sql\`...\`` in the moderator service. */
function moderatorCopy(name: string) {
  const source = readFileSync(MODERATOR_SERVICE, 'utf8');
  const copy = source.match(new RegExp(`const ${name} = sql\`([\\s\\S]*?)\`;`));
  expect(copy, `${name} not found in the moderator service`).not.toBeNull();
  return squash(copy![1]);
}

// The two apps share no runtime code. A drifted override check hides a blocked file from the
// moderator list while award still refuses it; a drifted count can throw the page.
describe('the moderator app copies of the file check SQL', () => {
  it.each([
    ['validOverride', VALID_OVERRIDE_SQL],
    ['failCount', HASH_FAIL_COUNT_SQL],
  ])('%s is the main app SQL', (name, main) => {
    expect(moderatorCopy(name)).toBe(squash(main.sql));
  });
});
