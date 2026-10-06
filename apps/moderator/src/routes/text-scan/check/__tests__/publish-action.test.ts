import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Check's `publish` action with the harness faked. Publishing puts each key live one at a time and
 * nothing rolls back, so what a refusal says was published is the record.
 */

vi.mock('$lib/server/db', () => ({ dbRead: {}, dbWrite: {} }));
vi.mock('$app/server', () => ({ getRequestEvent: vi.fn() }));

const harness = vi.hoisted(() => ({ getPrompts: vi.fn(), putPrompt: vi.fn() }));
vi.mock('$lib/server/text-scan-lab/harness-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/text-scan-lab/harness-client')>()),
  ...harness,
}));

const { actions } = await import('../+page.server');
const { LabHarnessError } = await import('$lib/server/text-scan-lab/harness-client');

const PUBLISH = { 'textScan.prompt.publish': true };

const publish = (fields: Record<string, string>, grants: Record<string, boolean> = PUBLISH) => {
  const data = new FormData();
  for (const [k, v] of Object.entries(fields)) data.append(k, v);
  const event = {
    request: { formData: async () => data },
    locals: { user: { id: 1 }, grants },
  } as unknown as Parameters<typeof actions.publish>[0];
  return actions.publish(event) as Promise<Record<string, unknown>>;
};

const activePrompts = (active: Record<string, number>) => ({
  active: Object.fromEntries(
    Object.entries(active).map(([key, id]) => [key, { id, key, content: `OLD ${key}` }])
  ),
  config: { model: 'm', maxInputChars: 1000, thinking: false },
});

const twoKeys = (activeIds: Record<string, number | null> = { base: 1, 'label:scam': 2 }) => ({
  prompts: JSON.stringify({ base: 'BASE PROMPT', 'label:scam': 'SCAM DEF' }),
  note: 'ship it',
  activeIds: JSON.stringify(activeIds),
});

beforeEach(() => {
  vi.clearAllMocks();
  harness.getPrompts.mockResolvedValue(activePrompts({ base: 1, 'label:scam': 2 }));
  harness.putPrompt.mockImplementation(async (key: string) => ({ id: 10, key }));
});

describe('publish', () => {
  it('returns 403 without textScan.prompt.publish, before touching the harness', async () => {
    const res = await publish(twoKeys(), {});
    expect(res).toMatchObject({ status: 403 });
    expect(harness.getPrompts).not.toHaveBeenCalled();
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('puts every changed key with the publish note', async () => {
    expect(await publish(twoKeys())).toEqual({ success: true, published: ['base', 'label:scam'] });
    expect(harness.putPrompt.mock.calls).toEqual([
      ['base', 'BASE PROMPT', 'ship it'],
      ['label:scam', 'SCAM DEF', 'ship it'],
    ]);
  });

  it('publishes a key that had no current version when the page loaded none', async () => {
    harness.getPrompts.mockResolvedValue(activePrompts({ base: 1 }));
    expect(await publish(twoKeys({ base: 1, 'label:scam': null }))).toMatchObject({
      success: true,
    });
  });

  it('refuses, naming the key, when someone published a newer version since the page loaded', async () => {
    harness.getPrompts.mockResolvedValue(activePrompts({ base: 1, 'label:scam': 3 }));
    const res = await publish(twoKeys());
    expect(res).toMatchObject({ status: 409 });
    expect((res as { data: { error: string } }).data.error).toMatch(
      /^Someone published a newer version of Scam \/ phishing definition/
    );
    // A reload alone would publish over the newer version, so the copy must not suggest one.
    expect((res as { data: { error: string } }).data.error).toContain(
      'Review the newer version first'
    );
    expect((res as { data: { error: string } }).data.error).not.toMatch(/reload/i);
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses a changed key sent without the version it was loaded against', async () => {
    const res = await publish(twoKeys({ base: 1 }));
    expect(res).toMatchObject({ status: 400 });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('requires a note', async () => {
    expect(await publish({ ...twoKeys(), note: '  ' })).toMatchObject({
      status: 400,
      data: { error: 'A publish note is required.' },
    });
    expect(harness.putPrompt).not.toHaveBeenCalled();
  });

  it('refuses a blank change by name', async () => {
    const res = await publish({ ...twoKeys(), prompts: JSON.stringify({ base: ' ' }) });
    expect(res).toMatchObject({
      status: 400,
      data: { error: 'General instructions is empty — write it, or reset it to current.' },
    });
    expect(harness.getPrompts).not.toHaveBeenCalled();
  });

  it('names what already went live when a later key fails', async () => {
    harness.putPrompt
      .mockResolvedValueOnce({ id: 11, key: 'base' })
      .mockRejectedValueOnce(new LabHarnessError('harness down'));
    const res = await publish(twoKeys());
    expect(res).toMatchObject({ status: 502, data: { published: ['base'] } });
    const { error } = (res as { data: { error: string } }).data;
    expect(error).toContain('Publishing Scam / phishing definition failed (harness down)');
    expect(error).toContain(
      'Already published: General instructions; the rest stay in your changes.'
    );
  });

  it('says plainly when the current prompts cannot be loaded', async () => {
    harness.getPrompts.mockRejectedValue(new LabHarnessError('harness down'));
    expect(await publish(twoKeys())).toMatchObject({
      status: 502,
      data: { error: 'Could not load the current prompts: harness down' },
    });
  });
});
