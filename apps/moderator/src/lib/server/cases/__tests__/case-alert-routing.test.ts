import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Kysely } from 'kysely';
import type { DB } from '@civitai/db-schema/kysely';

const sendEmailStrict = vi.hoisted(() => vi.fn(async () => ({ messageId: 'm' })));
vi.mock('@civitai/email', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@civitai/email')>()),
  sendEmailStrict,
}));
vi.mock('../../redis', () => ({ getSysRedis: () => ({}) }));

process.env.MODERATOR_DATABASE_URL ??= 'postgres://unused@127.0.0.1:1/unused';
const { defaultCaseIntakeDeps } = await import('../case-intake-action');
const { defaultCaseTickDeps } = await import('../case-tick');

beforeEach(() => {
  sendEmailStrict.mockClear();
  process.env.MODERATION_ALERT_EMAIL = 'mods@example.test';
  process.env.CASE_MINOR_ALERT_CC = 'legal@example.test';
});

const sent = () => (sendEmailStrict.mock.calls as unknown as [Record<string, unknown>][])[0][0];

// Legal is copied on a minor-flagged filing's alert; clock alerts go to Moderation only.
describe('case alert routing', () => {
  it('copies the minor-flag intake alert to the configured address', async () => {
    const deps = defaultCaseIntakeDeps({
      mainDb: {} as Kysely<DB>,
      appUrl: 'https://example.test',
      systemUserId: -1,
      log: () => undefined,
    });
    await deps.alert('s', 't');
    expect(sent()).toMatchObject({ to: 'mods@example.test', cc: 'legal@example.test' });
  });

  it('sends clock alerts to Moderation only', async () => {
    await defaultCaseTickDeps({} as Kysely<DB>).alert('s', 't');
    expect(sent()).toMatchObject({ to: 'mods@example.test', cc: null });
  });

  it('refuses to send when no alert address is configured', async () => {
    delete process.env.MODERATION_ALERT_EMAIL;
    await expect(defaultCaseTickDeps({} as Kysely<DB>).alert('s', 't')).rejects.toMatchObject({
      name: 'NoAlertAddress',
    });
    expect(sendEmailStrict).not.toHaveBeenCalled();
  });
});
