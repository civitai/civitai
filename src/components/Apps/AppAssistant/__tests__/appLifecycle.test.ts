import { describe, expect, it } from 'vitest';
import { oldestInactiveApp } from '~/components/Apps/AppAssistant/appLifecycle';
import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';

const app = (
  name: string,
  lastActivityAt: string | null,
  createdAt: string | null = '2026-09-01T00:00:00.000Z'
): Sandbox => ({
  name,
  app: name.replace('sbx-', 'app-'),
  state: 'suspended',
  mcpUrl: `https://sandbox.example/s/${name}/mcp`,
  createdAt,
  lastActivityAt,
  expiresAt: null,
});

// Pairwise distinct, and listed neither oldest-first nor newest-first.
const middle = app('sbx-middle', '2026-10-10T00:00:00.000Z', '2026-09-03T00:00:00.000Z');
const oldest = app('sbx-oldest', '2026-10-02T00:00:00.000Z', '2026-09-05T00:00:00.000Z');
const newest = app('sbx-newest', '2026-10-20T00:00:00.000Z', '2026-09-01T00:00:00.000Z');
const apps = [middle, oldest, newest];

describe('oldestInactiveApp (what the free-a-slot card offers to delete first)', () => {
  it('is the app used longest ago', () => {
    expect(oldestInactiveApp(apps, null)?.name).toBe('sbx-oldest');
    expect(oldestInactiveApp(apps, 'sbx-newest')?.name).toBe('sbx-oldest');
  });

  it('is never the app open now: the next oldest when the oldest is open', () => {
    expect(oldestInactiveApp(apps, 'sbx-oldest')?.name).toBe('sbx-middle');
  });

  it('goes by last use, not by creation (the oldest-created is the newest used)', () => {
    expect(oldestInactiveApp([newest, middle], null)?.name).toBe('sbx-middle');
  });

  it('an app never used counts from when it was made', () => {
    const neverUsed = app('sbx-fresh', null, '2026-10-15T00:00:00.000Z');
    expect(oldestInactiveApp([neverUsed, middle], null)?.name).toBe('sbx-middle');
    expect(oldestInactiveApp([neverUsed, newest], null)?.name).toBe('sbx-fresh');
  });

  it('is none when the open app is the only one', () => {
    expect(oldestInactiveApp([middle], 'sbx-middle')).toBeNull();
    expect(oldestInactiveApp([], null)).toBeNull();
  });
});
