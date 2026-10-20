import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';

const { mockCreateXGuardModerationRequest } = vi.hoisted(() => ({
  mockCreateXGuardModerationRequest: vi.fn(),
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createXGuardModerationRequest: mockCreateXGuardModerationRequest,
}));

import { assertSfwFaceSafe, checkSfwFace } from '~/server/services/model-sfw-face.service';

const succeeded = (results: { label: string; triggered: boolean; text?: string[] }[]) => ({
  status: 'succeeded',
  steps: [
    {
      output: {
        results: results.map(({ label, triggered, text }) => ({
          label,
          triggered,
          matchedTerms: text ? { text } : undefined,
        })),
      },
    },
  ],
});

const clean = succeeded([{ label: 'NSFW', triggered: false }]);

describe('checkSfwFace', () => {
  beforeEach(() => {
    mockCreateXGuardModerationRequest.mockReset();
  });

  it('returns a per-field verdict with the triggered label and matched terms', async () => {
    mockCreateXGuardModerationRequest.mockImplementation(async ({ content }) =>
      content.includes('Nude')
        ? succeeded([{ label: 'Suggestive', triggered: true, text: ['Nude'] }])
        : clean
    );

    const verdicts = await checkSfwFace({
      sfwName: 'Nude Boudoir Pack',
      sfwDescription: '<p>A retro illustration style.</p>',
      userId: 1,
    });

    expect(verdicts.sfwName).toEqual({
      status: 'flagged',
      labels: ['suggestive'],
      terms: ['Nude'],
    });
    expect(verdicts.sfwDescription).toEqual({ status: 'clean' });
  });

  it('checks the description as text, not markup', async () => {
    mockCreateXGuardModerationRequest.mockResolvedValue(clean);
    await checkSfwFace({ sfwDescription: '<p>A <strong>retro</strong> style.</p>', userId: 1 });
    expect(mockCreateXGuardModerationRequest.mock.calls[0][0].content).not.toContain('<');
  });

  it('never registers a callback, so a preview writes no moderation record', async () => {
    mockCreateXGuardModerationRequest.mockResolvedValue(clean);
    await checkSfwFace({ sfwName: 'Retro Pinup Style', userId: 1 });
    const args = mockCreateXGuardModerationRequest.mock.calls[0][0];
    expect(args.callbackUrl).toBeNull();
    expect(args.entityType).toBeUndefined();
    expect(args.entityId).toBeUndefined();
  });

  it('skips empty fields instead of scanning them', async () => {
    const verdicts = await checkSfwFace({ sfwName: '  ', sfwDescription: '<p></p>', userId: 1 });
    expect(verdicts).toEqual({});
    expect(mockCreateXGuardModerationRequest).not.toHaveBeenCalled();
  });

  it('reports unavailable when the scan fails or does not finish', async () => {
    mockCreateXGuardModerationRequest.mockRejectedValueOnce(new Error('timeout'));
    expect((await checkSfwFace({ sfwName: 'A', userId: 1 })).sfwName).toEqual({
      status: 'unavailable',
    });

    mockCreateXGuardModerationRequest.mockResolvedValueOnce({ status: 'processing', steps: [] });
    expect((await checkSfwFace({ sfwName: 'A', userId: 1 })).sfwName).toEqual({
      status: 'unavailable',
    });
  });
});

describe('assertSfwFaceSafe', () => {
  beforeEach(() => {
    mockCreateXGuardModerationRequest.mockReset();
  });

  it('refuses a flagged field, naming it', async () => {
    mockCreateXGuardModerationRequest.mockResolvedValue(
      succeeded([{ label: 'Explicit', triggered: true }])
    );
    await expect(assertSfwFaceSafe({ sfwName: 'x', userId: 1 })).rejects.toThrow('.com title');
  });

  it('refuses to save when the check cannot run', async () => {
    mockCreateXGuardModerationRequest.mockRejectedValue(new Error('down'));
    await expect(assertSfwFaceSafe({ sfwName: 'x', userId: 1 })).rejects.toThrow("couldn't check");
  });

  it('lets a clean face through', async () => {
    mockCreateXGuardModerationRequest.mockResolvedValue(clean);
    await expect(
      assertSfwFaceSafe({ sfwName: 'Retro Pinup Style', sfwDescription: '<p>ok</p>', userId: 1 })
    ).resolves.toBeUndefined();
  });
});
