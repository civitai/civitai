import { describe, expect, it } from 'vitest';
import type { RunnerAuthorizationRow, RunnerMintReads } from '@civitai/db-queries/recipe-runner';
import {
  decideRunnerMint,
  RUNNER_TOKEN_SCOPE,
  standingRunId,
  SYSTEM_CLIENT_OWNER_ID,
} from '~/server/services/blocks/runner-mint.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';

const NOW = new Date('2026-11-26T12:00:00Z');
const USER = 990000101;
const CLIENT = 'rcl_spam_pipe';
const APP_BLOCK = 'apb_spam_pipe';

const standing: RunnerAuthorizationRow = {
  id: 'rra_standing',
  userId: USER,
  runnerClientId: CLIENT,
  kind: 'standing',
  runId: null,
  maxAmountPerRun: 50,
  maxRunsPerPeriod: 3,
  period: 'day',
  createdAt: new Date('2026-11-21T00:00:00Z'),
  expiresAt: new Date('2026-12-20T00:00:00Z'),
  revokedAt: null,
};

/**
 * Every read answers the passing case only for the arguments the mint should pass, and the
 * refusing answer otherwise, so a read called with the wrong id fails the CONTROL test.
 */
function reads(over: Partial<RunnerMintReads> = {}): RunnerMintReads {
  const RUN = standingRunId(standing.id, 'trigger-1');
  return {
    client: async (clientId) =>
      clientId === CLIENT
        ? {
            userId: SYSTEM_CLIENT_OWNER_ID,
            isConfidential: true,
            skipConsent: false,
            grants: ['authorization_code', 'refresh_token'],
            accessMode: 'open',
          }
        : null,
    binding: async (clientId) =>
      clientId === CLIENT ? { appBlockId: APP_BLOCK, status: 'active' } : null,
    appBlock: async (id) =>
      id === APP_BLOCK
        ? { id: APP_BLOCK, appId: 'app', blockId: 'spam-pipe', status: 'approved' }
        : null,
    consent: async (userId, clientId) =>
      userId === USER && clientId === CLIENT
        ? {
            offlineGrantedAt: new Date('2026-11-20T00:00:00Z'),
            offlineBuzzLimit: 200,
            offlineBuzzPeriod: 'week',
          }
        : null,
    authorization: async (id) => (id === standing.id ? standing : null),
    hasLiveAttempt: async (runId) => runId !== RUN && runId !== 'run_abc',
    capUsed: async (userId, clientId) =>
      userId === USER && clientId === CLIENT ? 0 : Number.POSITIVE_INFINITY,
    runsSince: async (authorizationId) =>
      authorizationId === standing.id ? 0 : Number.POSITIVE_INFINITY,
    ...over,
  };
}

const decide = (
  r: RunnerMintReads,
  over: { tokenScope?: bigint; amount?: number; runKey?: string } = {}
) =>
  decideRunnerMint(
    {
      userId: USER,
      clientId: CLIENT,
      tokenScope: over.tokenScope ?? RUNNER_TOKEN_SCOPE,
      request: {
        authorizationId: standing.id,
        runKey: over.runKey ?? 'trigger-1',
        amount: over.amount ?? 40,
      },
      now: NOW,
    },
    r
  );

const refusal = async (r: RunnerMintReads, over?: Parameters<typeof decide>[1]) => {
  const d = await decide(r, over);
  return d.ok ? 'minted' : d.refusal;
};

// The cap, per-run and period rules pinned here are the runner mint policy of civitai/civitai#10543.
describe('decideRunnerMint', () => {
  it('CONTROL: mints for a bound runner client, a capped consent and a live authorization', async () => {
    const d = await decide(reads());
    expect(d).toEqual({
      ok: true,
      grant: {
        runId: standingRunId(standing.id, 'trigger-1'),
        authorizationId: standing.id,
        appBlock: { id: APP_BLOCK, appId: 'app', blockId: 'spam-pipe', status: 'approved' },
        buzzBudget: 40,
      },
    });
  });

  it('refuses any token scope other than exactly runner + UserRead', async () => {
    for (const tokenScope of [
      TokenScope.RunnerMint,
      RUNNER_TOKEN_SCOPE | TokenScope.AIServicesWrite,
      TokenScope.UserRead,
    ]) {
      expect(await refusal(reads(), { tokenScope }), String(tokenScope)).toBe('scope');
    }
  });

  it('refuses a client that is not Civitai-owned, confidential, consented, device-free and open', async () => {
    const base = {
      userId: SYSTEM_CLIENT_OWNER_ID,
      isConfidential: true,
      skipConsent: false,
      grants: ['authorization_code'],
      accessMode: 'open',
    };
    for (const client of [
      { ...base, userId: 42 },
      { ...base, isConfidential: false },
      { ...base, skipConsent: true },
      // As stored: the full grant-type URN.
      { ...base, grants: ['authorization_code', 'urn:ietf:params:oauth:grant-type:device_code'] },
      // A hand-written row with the bare name.
      { ...base, grants: ['authorization_code', 'device_code'] },
      { ...base, accessMode: 'disabled' },
      { ...base, accessMode: 'testers' },
      null,
    ]) {
      expect(await refusal(reads({ client: async () => client })), JSON.stringify(client)).toBe(
        'client'
      );
    }
  });

  it('refuses a missing or suspended binding, and an app block that is not approved', async () => {
    expect(await refusal(reads({ binding: async () => null }))).toBe('binding');
    expect(
      await refusal(
        reads({ binding: async () => ({ appBlockId: APP_BLOCK, status: 'suspended' }) })
      )
    ).toBe('binding');
    for (const status of ['suspended', 'pending', 'rejected']) {
      expect(
        await refusal(
          reads({ appBlock: async () => ({ id: APP_BLOCK, appId: 'app', blockId: 'b', status }) })
        )
      ).toBe('app_block');
    }
  });

  it('refuses without an offline grant, and without a cap', async () => {
    const grant = { offlineGrantedAt: new Date('2026-11-20T00:00:00Z') };
    expect(await refusal(reads({ consent: async () => null }))).toBe('consent');
    expect(
      await refusal(
        reads({
          consent: async () => ({
            offlineGrantedAt: null,
            offlineBuzzLimit: 200,
            offlineBuzzPeriod: 'day',
          }),
        })
      )
    ).toBe('consent');
    for (const cap of [
      { offlineBuzzLimit: null, offlineBuzzPeriod: null },
      { offlineBuzzLimit: 200, offlineBuzzPeriod: null },
      { offlineBuzzLimit: 0, offlineBuzzPeriod: 'day' },
      { offlineBuzzLimit: 200, offlineBuzzPeriod: 'year' },
    ]) {
      expect(
        await refusal(reads({ consent: async () => ({ ...grant, ...cap }) })),
        JSON.stringify(cap)
      ).toBe('cap');
    }
  });

  it('refuses an authorization of another user or client, revoked, expired or of an unknown kind', async () => {
    for (const over of [
      { userId: USER + 1 },
      { runnerClientId: 'rcl_other' },
      { revokedAt: new Date('2026-11-25T00:00:00Z') },
      { expiresAt: NOW },
      // made before the current offline grant (2026-11-20)
      { createdAt: new Date('2026-11-19T00:00:00Z') },
      { kind: 'forever' },
      { maxRunsPerPeriod: null },
      { period: null },
      { period: 'year' },
    ]) {
      expect(
        await refusal(reads({ authorization: async () => ({ ...standing, ...over }) })),
        JSON.stringify(over)
      ).toBe('authorization');
    }
    expect(await refusal(reads({ authorization: async () => null }))).toBe('authorization');
  });

  it('a single authorization mints only its own run id', async () => {
    const single = {
      ...standing,
      kind: 'single',
      runId: 'run_abc',
      maxRunsPerPeriod: null,
      period: null,
    };
    const r = reads({ authorization: async () => single });
    expect(await refusal(r, { runKey: 'run_other' })).toBe('authorization');
    const d = await decide(r, { runKey: 'run_abc' });
    expect(d.ok && d.grant.runId).toBe('run_abc');
  });

  it('refuses an amount over the authorization per-run max', async () => {
    expect(await refusal(reads(), { amount: 51 })).toBe('amount');
    expect(await refusal(reads(), { amount: 50 })).toBe('minted');
  });

  it('refuses a run that already has a live attempt', async () => {
    expect(await refusal(reads({ hasLiveAttempt: async () => true }))).toBe('run_live');
  });

  it('refuses past the offline cap, and mints at exactly the headroom', async () => {
    expect(await refusal(reads({ capUsed: async () => 161 }))).toBe('cap');
    const d = await decide(reads({ capUsed: async () => 160 }));
    expect(d.ok && d.grant.buzzBudget).toBe(40);
  });

  it('counts the cap over its own rolling period, and the runs over the authorization period', async () => {
    const since: Date[] = [];
    await decide(
      reads({
        capUsed: async (_u, _c, s) => (since.push(s), 0),
        runsSince: async (_a, s) => (since.push(s), 0),
      })
    );
    expect(since.map((d) => d.toISOString())).toEqual([
      '2026-11-19T12:00:00.000Z', // week, the consent cap
      '2026-11-25T12:00:00.000Z', // day, the authorization
    ]);
  });

  it('refuses a standing authorization at its runs-per-period limit', async () => {
    expect(await refusal(reads({ runsSince: async () => 3 }))).toBe('runs_per_period');
    expect(await refusal(reads({ runsSince: async () => 2 }))).toBe('minted');
  });

  it('a replayed trigger is the same run; another trigger is a different one', () => {
    expect(standingRunId('rra_a', 't1')).toBe(standingRunId('rra_a', 't1'));
    expect(standingRunId('rra_a', 't1')).not.toBe(standingRunId('rra_a', 't2'));
    expect(standingRunId('rra_a', 't1')).not.toBe(standingRunId('rra_b', 't1'));
  });
});
