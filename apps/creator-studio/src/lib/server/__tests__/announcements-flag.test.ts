import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionUser } from '@civitai/auth';
import { TESTER_ID } from './flipt-fake';

const fake = await vi.hoisted(async () => {
  const { createFliptFake } = await import('./flipt-fake');
  return createFliptFake('creator-announcements');
});

vi.mock('$lib/server/db', () => ({ dbRead: {} }));
vi.mock('$lib/server/main-app', () => ({ callMainApp: vi.fn() }));
vi.mock('$lib/server/flipt', () => fake.fliptModule);

const { announcementsEnabled } = await import('../announcements');

const enabledFor = (user: { id: number; isModerator?: boolean }) =>
  announcementsEnabled(user as SessionUser);

// The tester case is what pins the key: it can only pass if the key matches the main app's
// `creatorAnnouncements` fliptKey, which the fake answers for.
describe('announcementsEnabled', () => {
  beforeEach(() => fake.reset());

  it('follows Flipt for a tester', async () => {
    expect(await enabledFor({ id: TESTER_ID })).toBe(true);
  });

  it('is off for everyone else', async () => {
    expect(await enabledFor({ id: 7 })).toBe(false);
  });

  it('falls back to moderators only when Flipt has no answer', async () => {
    fake.state.segment = () => null;
    expect(await enabledFor({ id: 1, isModerator: true })).toBe(true);
    expect(await enabledFor({ id: TESTER_ID })).toBe(false);
  });
});
