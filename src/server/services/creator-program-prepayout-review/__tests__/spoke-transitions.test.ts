import { readFileSync } from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../../../..');

/** `{ action: ['status', ...] }` from the object literal assigned to `name` in `file`. */
function transitionsIn(file: string, name: string): Record<string, string[]> {
  const source = readFileSync(path.join(root, file), 'utf8');
  const block = source.match(new RegExp(String.raw`const ${name}[^{]*\{([\s\S]*?)\n\};`));
  if (!block) throw new Error(`${name} not found in ${file}`);
  const entries = [...block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)];
  return Object.fromEntries(
    entries.map(([, action, list]) => [action, [...list.matchAll(/'(\w+)'/g)].map((m) => m[1])])
  );
}

describe('the moderator Payout Reviews page', () => {
  // The page picks its buttons from a copy; a transition changed here and not there shows buttons
  // the endpoint refuses, or hides ones it allows.
  it('offers exactly the transitions decidePayoutReview accepts', () => {
    const server = transitionsIn(
      'src/server/services/creator-program-prepayout-review/hold.ts',
      'TRANSITIONS'
    );
    const spoke = transitionsIn('apps/moderator/src/lib/payout-review.ts', 'ALLOWED_FROM');

    expect(Object.keys(server).sort()).toEqual(['clear', 'escalate', 'withhold']);
    expect(spoke).toEqual(server);
  });
});
