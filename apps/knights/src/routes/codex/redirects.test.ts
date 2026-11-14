import { describe, expect, it } from 'vitest';
import { GET as ranks } from '../ranks/+server';
import { GET as rules } from '../rules/+server';

async function redirectOf(run: () => unknown) {
  try {
    await run();
  } catch (thrown) {
    return thrown as { status: number; location: string };
  }
  throw new Error('did not redirect');
}

describe('the old Ranks and Rules pages', () => {
  it('send /ranks to the Codex ranks section, permanently', async () => {
    expect(await redirectOf(() => ranks({} as never))).toMatchObject({
      status: 308,
      location: '/codex#ranks',
    });
  });

  it('send /rules to the Codex judging section, permanently', async () => {
    expect(await redirectOf(() => rules({} as never))).toMatchObject({
      status: 308,
      location: '/codex#judging',
    });
  });
});
