import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as Access from '$lib/server/access';
import type * as Capture from '$lib/server/text-scan-tests/capture';

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));
vi.mock('$lib/server/moderator-db', () => ({ getModeratorDb: () => ({}) }));

const access = vi.hoisted(() => ({ canAccess: vi.fn(() => true) }));
vi.mock('$lib/server/access', async (importOriginal) => ({
  ...(await importOriginal<typeof Access>()),
  ...access,
}));
const capture = vi.hoisted(() => ({ captureCase: vi.fn() }));
vi.mock('$lib/server/text-scan-tests/capture', async (importOriginal) => ({
  ...(await importOriginal<typeof Capture>()),
  ...capture,
}));
const activity = vi.hoisted(() => ({ recordModActivity: vi.fn() }));
vi.mock('$lib/server/mod-activity', () => activity);

const { actions } = await import('../+page.server');

const EDIT = { 'textScan.testSets.edit': true };
const post = (
  action: keyof typeof actions,
  fields: Record<string, string>,
  grants: Record<string, boolean> = EDIT
) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1, roles: [] }, grants },
  } as unknown as Parameters<(typeof actions)['addCase']>[0];
  return (actions[action] as (e: typeof event) => Promise<unknown>)(event) as Promise<
    Record<string, unknown>
  >;
};

const FREE_TEXT = {
  setId: '3',
  workspace: 'prompts',
  entityType: 'CommentV2',
  fields: JSON.stringify([{ heading: 'Comment', text: 'synthetic text' }]),
  expected: JSON.stringify({ scam: true }),
  origin: 'try',
};

beforeEach(() => {
  vi.clearAllMocks();
  access.canAccess.mockReturnValue(true);
  capture.captureCase.mockResolvedValue({ setId: 3, caseId: 9, created: true, setCreated: false });
});

describe('addCase', () => {
  it('returns 403 without textScan.testSets.edit, before touching the store', async () => {
    expect(await post('addCase', FREE_TEXT, {})).toMatchObject({ status: 403 });
    expect(capture.captureCase).not.toHaveBeenCalled();
  });

  it('refuses a form with neither a set nor a new set name', async () => {
    const { setId: _, ...noSet } = FREE_TEXT;
    expect(await post('addCase', noSet)).toMatchObject({
      status: 400,
      data: { error: 'Pick a set or name a new one.' },
    });
  });

  it('refuses when the moderator cannot open the workspace the set belongs to', async () => {
    access.canAccess.mockReturnValue(false);
    expect(await post('addCase', FREE_TEXT)).toMatchObject({ status: 403 });
    expect(capture.captureCase).not.toHaveBeenCalled();
  });

  it('records the entity type and id, never the text', async () => {
    expect(await post('addCase', FREE_TEXT)).toMatchObject({ success: true, caseId: 9 });
    expect(activity.recordModActivity).toHaveBeenCalledExactlyOnceWith({
      userId: 1,
      entityType: 'CommentV2',
      entityId: null,
      activity: 'textScan.testCase.add',
    });
  });
});

describe('createSet', () => {
  it('returns 403 without textScan.testSets.edit', async () => {
    expect(await post('createSet', { name: 'synthetic', workspace: 'prompts' }, {})).toMatchObject({
      status: 403,
    });
  });
});
