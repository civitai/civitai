import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubmitModule from '~/server/services/text-scan/submit';
import type * as ModeModule from '~/server/services/text-scan/mode';
import type * as PromptModule from '~/server/services/text-scan/prompt';
import { dbMock } from '~/__tests__/mocks/db.mock';

vi.mock('~/server/services/text-scan/profiles/index', () => ({}));
vi.mock('~/server/services/text-scan/submit', async (importOriginal) => ({
  ...(await importOriginal<typeof SubmitModule>()),
  scanEntity: vi.fn(),
}));
vi.mock('~/server/services/text-scan/mode', async (importOriginal) => ({
  ...(await importOriginal<typeof ModeModule>()),
  getTextScanMode: vi.fn(),
  getTextScanWebSearchMode: vi.fn(),
}));

const {
  createTextScanAdapter,
  createTextScanShadowAdapter,
  textScanShadowAdapters,
  textScanWebSearchAdapters,
  TEXT_SCAN_RETRY_CONTENT,
} = await import('~/server/services/text-scan/adapter');
const { TEXT_SCAN_ENTITY_GONE, TEXT_SCAN_ENTITY_NOT_PUBLIC } = await import(
  '~/server/services/text-scan/route'
);
const { registerTextScanProfile } = await import('~/server/services/text-scan/profiles');
const { scanEntity } = await import('~/server/services/text-scan/submit');
const { getTextScanMode, getTextScanWebSearchMode } = await import(
  '~/server/services/text-scan/mode'
);

const load = vi.fn();
registerTextScanProfile({ entityType: 'Post', labels: ['nsfw'], minChars: 5, load });
const applyTextScan = vi.fn();
const adapter = createTextScanAdapter('Post', { applyTextScan });

beforeEach(() => vi.clearAllMocks());

describe('createTextScanAdapter', () => {
  it('resolves content only for present entities that meet minChars', async () => {
    load.mockResolvedValue(
      new Map([
        [1, { fields: [{ heading: 'Name', text: 'Hello' }], declared: {} }],
        [2, { fields: [{ heading: 'A long heading', text: 'hi' }], declared: {} }],
      ])
    );
    const map = await adapter.resolveContent([1, 2, 3]);
    expect([...map.keys()]).toEqual([1]);
    expect(map.get(1)).toBe(TEXT_SCAN_RETRY_CONTENT);
  });

  // Omitting it would take the cron's missing path and delete the row, and with it the stored
  // verdict a rating floor still reads.
  it('resolves a not-public entity whatever its length, so its row is kept', async () => {
    load.mockResolvedValue(
      new Map([[1, { fields: [{ heading: 'Name', text: 'hi' }], declared: {}, notPublic: true }]])
    );
    expect([...(await adapter.resolveContent([1])).keys()]).toEqual([1]);
  });

  it('resolves a short marker, not the composed text, however long the text is', async () => {
    load.mockResolvedValue(
      new Map([[1, { fields: [{ heading: 'Name', text: 'x'.repeat(500_000) }], declared: {} }]])
    );
    const map = await adapter.resolveContent([1]);
    expect(map.get(1)).toBe(TEXT_SCAN_RETRY_CONTENT);
    expect(TEXT_SCAN_RETRY_CONTENT.length).toBeLessThan(20);
  });

  it('submits through scanEntity and returns the workflow id', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'submitted', workflowId: 'wf-9' });
    expect(await adapter.submit({ entityId: 1, content: 'ignored' })).toEqual({ id: 'wf-9' });
    expect(scanEntity).toHaveBeenCalledWith({ entityType: 'Post', entityId: 1, fromRetry: true });
  });

  it('returns null for skipped or failed submits', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'skipped', reason: 'missing-prompt' });
    expect(await adapter.submit({ entityId: 1, content: '' })).toBeNull();
    vi.mocked(scanEntity).mockResolvedValue({ status: 'failed' });
    expect(await adapter.submit({ entityId: 1, content: '' })).toBeNull();
  });

  it('returns the gone marker when the entity can no longer be loaded', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'skipped', reason: 'missing' });
    expect(await adapter.submit({ entityId: 1, content: '' })).toBe(TEXT_SCAN_ENTITY_GONE);
    expect(
      await textScanWebSearchAdapters()['Model:search'].submit({ entityId: 1, content: '' })
    ).toBe(TEXT_SCAN_ENTITY_GONE);
  });

  it('returns the not-public marker for an entity that exists but is not public', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'skipped', reason: 'not-public' });
    expect(await adapter.submit({ entityId: 1, content: '' })).toBe(TEXT_SCAN_ENTITY_NOT_PUBLIC);
  });

  it.each([
    ['off', false],
    ['shadow', false],
    ['active', true],
  ] as const)('a live adapter is enabled in %s mode: %s', async (mode, enabled) => {
    vi.mocked(getTextScanMode).mockResolvedValue(mode);
    expect(await adapter.isEnabled!({ entityId: 1 })).toBe(enabled);
  });

  it.each([
    ['off', false],
    ['shadow', true],
    ['active', false],
  ] as const)('a shadow adapter is enabled in %s mode: %s', async (mode, enabled) => {
    vi.mocked(getTextScanMode).mockResolvedValue(mode);
    expect(await createTextScanShadowAdapter('Post').isEnabled!({ entityId: 1 })).toBe(enabled);
  });

  it('registers a hookless shadow adapter for each of the 18 entities', () => {
    const adapters = textScanShadowAdapters();
    expect(Object.keys(adapters)).toHaveLength(18);
    for (const key of [
      'Crucible:shadow',
      'Collection:shadow',
      'Storyline:shadow',
      'ImageCaption:shadow',
      'ModelRules:shadow',
    ]) {
      expect(adapters[key]).toBeDefined();
      expect(adapters[key].applyTextScan).toBeUndefined();
      expect(adapters[key].applyFailure).toBeUndefined();
    }
    expect(adapters['Article:shadow'].applyTextScan).toBeUndefined();
    expect(adapters['Article:shadow'].applyFailure).toBeUndefined();
  });

  it('passes the hooks through', () => {
    expect(adapter.applyTextScan).toBe(applyTextScan);
    expect(adapter.applyResult).toBeUndefined();
  });
});

describe('submitViaTextScan (retry cron)', () => {
  it('spends a retry when the scan cannot be built, so the row is not reselected forever', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'skipped', reason: 'missing-prompt' });
    await expect(adapter.submit({ entityId: 9, content: '' })).resolves.toBeNull();
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenCalledWith({
      where: {
        entityType: { in: ['Post', 'Post:shadow'] },
        entityId: 9,
        status: { not: 'Succeeded' },
      },
      data: { retryCount: { increment: 1 } },
    });
  });

  it('covers the live and shadow rows of ModelRules too', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'skipped', reason: 'missing-prompt' });
    await createTextScanAdapter('ModelRules', {}).submit({ entityId: 4, content: '' });
    expect(dbMock.dbWrite.entityModeration.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entityType: { in: ['ModelRules', 'ModelRules:shadow'] },
        }),
      })
    );
  });

  it('leaves the budget alone for other skips', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'skipped', reason: 'off' });
    await adapter.submit({ entityId: 9, content: '' });
    expect(dbMock.dbWrite.entityModeration.updateMany).not.toHaveBeenCalled();
  });
});

describe('textScanWebSearchAdapters', () => {
  const adapters = textScanWebSearchAdapters();

  it('registers a hookless adapter per web-search row, Model only', () => {
    expect(Object.keys(adapters).sort()).toEqual(['Model:search', 'Model:search-shadow']);
    for (const a of Object.values(adapters)) {
      expect(a.applyTextScan).toBeUndefined();
      expect(a.applyFailure).toBeUndefined();
    }
  });

  it.each([
    ['Model:search', 'active', true],
    ['Model:search', 'shadow', false],
    ['Model:search-shadow', 'shadow', true],
    ['Model:search-shadow', 'active', false],
    ['Model:search-shadow', 'off', false],
  ] as const)('%s is enabled in search mode %s: %s', async (key, mode, enabled) => {
    vi.mocked(getTextScanWebSearchMode).mockResolvedValue(mode);
    expect(await adapters[key].isEnabled!({ entityId: 1 })).toBe(enabled);
    expect(getTextScanWebSearchMode).toHaveBeenCalledWith('Model', 1);
  });

  it('resubmits only the web-search pass', async () => {
    vi.mocked(scanEntity).mockResolvedValue({ status: 'submitted', workflowId: 'wf-s' });
    expect(await adapters['Model:search'].submit({ entityId: 1, content: '' })).toEqual({
      id: 'wf-s',
    });
    expect(scanEntity).toHaveBeenCalledWith({
      entityType: 'Model',
      entityId: 1,
      fromRetry: true,
      pass: 'web-search',
    });
  });
});
