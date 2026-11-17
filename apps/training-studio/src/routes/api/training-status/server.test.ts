import { describe, expect, it, vi } from 'vitest';

const status = vi.hoisted(() => ({ value: {} as Record<string, unknown> }));
vi.mock('$lib/server/service-status', async () => {
  const { parseServiceStatus } = await import('$lib/service-status-core');
  return { getTrainingServiceStatus: async () => parseServiceStatus(status.value) };
});

const { GET } = await import('./+server');

describe('GET /api/training-status', () => {
  it('returns blocked catalog models and their notes, never blocked custom-model AIRs', async () => {
    const customAir = 'urn:air:sd1:checkpoint:civitai:53761@285757';
    status.value = {
      available: true,
      message: 'Slow today.',
      blockedModels: [customAir, 'krea2'],
      blockedModelReasons: { krea2: 'Provider outage.', [customAir]: 'Not licensed.' },
    };
    const body = await (await GET({} as never)).json();
    expect(body).toEqual({
      available: true,
      message: 'Slow today.',
      blockedModels: ['krea2'],
      blockedModelReasons: { krea2: 'Provider outage.' },
    });
  });
});
