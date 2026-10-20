import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as OrchestratorService from '~/server/services/orchestrator/orchestrator.service';

const { mockCreateXGuardModerationRequest, mockSubmitWorkflow } = vi.hoisted(() => ({
  mockCreateXGuardModerationRequest: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
}));

// The package's ESM build can't be loaded by `importOriginal` here; every suite fakes it whole.
vi.mock('@civitai/client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: mockSubmitWorkflow,
}));

vi.mock('~/server/services/orchestrator/orchestrator.service', async (importOriginal) => ({
  ...(await importOriginal<typeof OrchestratorService>()),
  createXGuardModerationRequest: mockCreateXGuardModerationRequest,
}));

import {
  assertSfwFaceSafe,
  checkSfwFace,
  draftSfwFace,
} from '~/server/services/model-sfw-face.service';

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

describe('draftSfwFace', () => {
  const draftReply = (title: string, description: string) => ({
    data: {
      status: 'succeeded',
      steps: [
        {
          output: {
            choices: [{ message: { content: JSON.stringify({ title, description }) } }],
          },
        },
      ],
    },
  });

  beforeEach(() => {
    mockCreateXGuardModerationRequest.mockReset();
    mockSubmitWorkflow.mockReset();
  });

  it('asks for one revision when the check still flags the draft', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(draftReply('Nude Pinup Pack', '<p>Retro style.</p>'))
      .mockResolvedValueOnce(draftReply('Retro Pinup Style', '<p>Retro style.</p>'));
    mockCreateXGuardModerationRequest.mockImplementation(async ({ content }) =>
      content.includes('Nude') ? succeeded([{ label: 'NSFW', triggered: true }]) : clean
    );

    const draft = await draftSfwFace({ name: 'Nude Pinup Pack', userId: 1 });

    expect(draft.sfwName).toBe('Retro Pinup Style');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    const revision = mockSubmitWorkflow.mock.calls[1][0].body.steps[0].input.messages;
    expect(revision.at(-1).content).toContain('title is still rated nsfw');
  });

  it('returns the first draft when it already passes', async () => {
    mockSubmitWorkflow.mockResolvedValueOnce(draftReply('Retro Pinup Style', '<p>ok</p>'));
    mockCreateXGuardModerationRequest.mockResolvedValue(clean);
    await draftSfwFace({ name: 'x', userId: 1 });
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses with a retryable message when the model gives no usable answer', async () => {
    mockSubmitWorkflow.mockResolvedValueOnce({ data: { status: 'failed', steps: [] } });
    await expect(draftSfwFace({ name: 'x', userId: 1 })).rejects.toThrow("couldn't draft");
  });
});
