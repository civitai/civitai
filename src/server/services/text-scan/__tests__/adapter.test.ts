import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as SubmitModule from '~/server/services/text-scan/submit';
import type * as ModeModule from '~/server/services/text-scan/mode';

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

  it('registers a hookless shadow adapter for each of the 14 entities', () => {
    const adapters = textScanShadowAdapters();
    expect(Object.keys(adapters)).toHaveLength(14);
    for (const key of ['Crucible:shadow', 'Collection:shadow']) {
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
