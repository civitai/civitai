import { NsfwLevel } from '@civitai/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { send, rows } = vi.hoisted(() => ({
  send: vi.fn(),
  rows: [] as { id: number; nsfwLevel: number }[],
}));

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
const query = {
  select: () => query,
  where: () => query,
  execute,
};
vi.mock('$lib/server/db', () => ({ dbRead: { selectFrom: () => query }, dbWrite: {} }));
vi.mock('$lib/server/notifications', () => ({ getNotifications: () => ({}) }));
vi.mock('$lib/server/clickhouse', () => ({ getClickhouse: () => ({}) }));
vi.mock('../emails/appeal-resolution.email', () => ({ appealResolutionEmail: { send } }));
vi.mock('../civitai-url', () => ({
  civitaiAppUrl: () => 'https://com.test',
  civitaiLinkUrl: () => 'https://red.test',
}));

const { emailAppealResolution } = await import('../image-moderation-effects');

describe('emailAppealResolution', () => {
  beforeEach(() => {
    send.mockClear();
    rows.length = 0;
    execute.mockImplementation(async () => rows);
  });
  const sentUrls = () => send.mock.calls[0][0].items.map((i: { url?: string }) => i.url);

  it('links images civitai.com will not serve to .red, and safe ones to civitai.com', async () => {
    rows.push(
      { id: 1, nsfwLevel: NsfwLevel.X },
      { id: 2, nsfwLevel: NsfwLevel.PG },
      { id: 3, nsfwLevel: 0 }
    );
    await emailAppealResolution({
      to: 'a@b.test',
      username: 'a',
      approved: false,
      imageIds: [1, 2, 3, 4, 5],
    });

    expect(sentUrls()).toEqual([
      'https://red.test/images/1',
      'https://com.test/images/2',
      'https://red.test/images/3',
      'https://red.test/images/4',
      'https://red.test/images/5',
    ]);
  });

  it('still sends the email, linking to .red, when the rating read fails', async () => {
    execute.mockRejectedValue(new Error('read failed'));
    await emailAppealResolution({ to: 'a@b.test', username: 'a', approved: true, imageIds: [2] });
    expect(sentUrls()).toEqual(['https://red.test/images/2']);
  });
});
