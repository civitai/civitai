import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAYOUT_REVIEW_ACTIONS, allowedActions } from '../payout-review';

const HOLD_TS = fileURLToPath(
  new URL(
    '../../../../../src/server/services/creator-program-prepayout-review/hold.ts',
    import.meta.url
  )
);

/** The main app's TRANSITIONS, read from its source so a change there turns this red. */
function serverTransitions(): Record<string, string[]> {
  const block = readFileSync(HOLD_TS, 'utf8').match(/const TRANSITIONS[^{]*\{([\s\S]*?)\n\};/);
  if (!block) throw new Error(`TRANSITIONS not found in ${HOLD_TS}`);
  const entries = [...block[1].matchAll(/^\s*(\w+):\s*\[([^\]]*)\]/gm)];
  return Object.fromEntries(
    entries.map(([, action, list]) => [action, [...list.matchAll(/'(\w+)'/g)].map((m) => m[1])])
  );
}

describe('allowedActions', () => {
  it('offers exactly the transitions the decision endpoint accepts', () => {
    const transitions = serverTransitions();
    expect(Object.keys(transitions).sort()).toEqual([...PAYOUT_REVIEW_ACTIONS].sort());
    for (const status of ['open', 'escalated', 'withheld', 'cleared'])
      expect(allowedActions(status), status).toEqual(
        PAYOUT_REVIEW_ACTIONS.filter((a) => transitions[a].includes(status))
      );
  });

  it('offers nothing on a status the endpoint has no transition from', () => {
    expect(allowedActions('superseded')).toEqual([]);
  });
});
