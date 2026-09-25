import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as FliptClient from '~/server/flipt/client';

vi.mock('~/server/flipt/client', async (importOriginal) => ({
  ...(await importOriginal<typeof FliptClient>()),
  getFliptVariant: vi.fn(),
}));

const { getTextScanMode, TEXT_SCAN_FLAG, textScanEmEntityType, parseTextScanEmEntityType } =
  await import('~/server/services/text-scan/mode');
const { getFliptVariant } = await import('~/server/flipt/client');
const { isTextScanEntityType } = await import('~/server/services/text-scan/profiles');

describe('getTextScanMode', () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    ['shadow', 'shadow'],
    ['active', 'active'],
    ['off', 'off'],
    [null, 'off'],
    ['ACTIVE', 'off'],
    ['', 'off'],
  ])('variant %s -> %s', async (variant, mode) => {
    vi.mocked(getFliptVariant).mockResolvedValue(variant as string | null);
    expect(await getTextScanMode('Post', 42)).toBe(mode);
  });

  it('evaluates the entity flag keyed on the entity id', async () => {
    vi.mocked(getFliptVariant).mockResolvedValue('shadow');
    await getTextScanMode('ChatMessage', 99);
    expect(getFliptVariant).toHaveBeenCalledWith('text-scan-chat', '99');
  });

  it('reads off when Flipt throws', async () => {
    vi.mocked(getFliptVariant).mockRejectedValue(new Error('down'));
    expect(await getTextScanMode('Model', 1)).toBe('off');
  });

  it('has a distinct flag per entity type', () => {
    const flags = Object.values(TEXT_SCAN_FLAG);
    expect(new Set(flags).size).toBe(flags.length);
    expect(flags).toHaveLength(12);
    expect(Object.keys(TEXT_SCAN_FLAG)).not.toContain('Collection');
  });
});

describe('isTextScanEntityType', () => {
  it.each([
    ['Post', true],
    ['UserProfile', true],
    ['Collection', false],
    ['Post:shadow', false],
    ['constructor', false],
    ['toString', false],
    ['__proto__', false],
  ])('%s -> %s', (value, expected) => expect(isTextScanEntityType(value)).toBe(expected));
});

describe('textScanEmEntityType', () => {
  it('keys shadow verdicts apart from the live row and round-trips', () => {
    expect(textScanEmEntityType('Article', 'active')).toBe('Article');
    expect(textScanEmEntityType('Article', 'shadow')).toBe('Article:shadow');
    expect(parseTextScanEmEntityType('Article:shadow')).toEqual({
      entityType: 'Article',
      shadow: true,
    });
    expect(parseTextScanEmEntityType('Article')).toEqual({ entityType: 'Article', shadow: false });
  });
});
