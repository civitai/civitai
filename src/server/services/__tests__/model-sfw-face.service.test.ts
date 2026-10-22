import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as TextScanPreview from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';

const { mockPreviewTextScanNsfw, mockSubmitWorkflow } = vi.hoisted(() => ({
  mockPreviewTextScanNsfw: vi.fn(),
  mockSubmitWorkflow: vi.fn(),
}));

// The package's ESM build can't be loaded by `importOriginal` here; every suite fakes it whole.
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: mockSubmitWorkflow,
}));

vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewTextScanNsfw: mockPreviewTextScanNsfw,
}));

import {
  assertSfwFaceSafe,
  checkSfwFace,
  draftSfwFace,
} from '~/server/services/model-sfw-face.service';

const rated = (level: NsfwLevel, reason = 'reason') => ({ status: 'ok', level, reason });
const fieldText = (call: unknown[]) =>
  (call[0] as { fields: TextScanField[] }).fields.map((field) => field.text).join(' ');

describe('checkSfwFace', () => {
  beforeEach(() => {
    mockPreviewTextScanNsfw.mockReset();
  });

  it('flags a field the text-scan rates above PG-13, with its rating and reason', async () => {
    mockPreviewTextScanNsfw.mockImplementation(async ({ fields }: { fields: TextScanField[] }) =>
      fields[0].text?.includes('Nude') ? rated(NsfwLevel.X, 'names nudity') : rated(NsfwLevel.PG)
    );

    const verdicts = await checkSfwFace({
      sfwName: 'Nude Boudoir Pack',
      sfwDescription: '<p>A retro illustration style.</p>',
      userId: 1,
    });

    expect(verdicts.sfwName).toEqual({ status: 'flagged', level: 'X', reason: 'names nudity' });
    expect(verdicts.sfwDescription).toEqual({ status: 'clean' });
  });

  it('lets PG-13 through, as .com shows it to signed-in viewers', async () => {
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.PG13));
    expect((await checkSfwFace({ sfwName: 'Swimwear Style', userId: 1 })).sfwName).toEqual({
      status: 'clean',
    });
  });

  it('checks the description as text, not markup', async () => {
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.PG));
    await checkSfwFace({ sfwDescription: '<p>A <strong>retro</strong> style.</p>', userId: 1 });
    expect(fieldText(mockPreviewTextScanNsfw.mock.calls[0])).not.toContain('<');
  });

  it('skips empty fields instead of scanning them', async () => {
    const verdicts = await checkSfwFace({ sfwName: '  ', sfwDescription: '<p></p>', userId: 1 });
    expect(verdicts).toEqual({});
    expect(mockPreviewTextScanNsfw).not.toHaveBeenCalled();
  });

  it('reports unavailable when the scan fails or gives no verdict', async () => {
    mockPreviewTextScanNsfw.mockRejectedValueOnce(new Error('timeout'));
    expect((await checkSfwFace({ sfwName: 'A', userId: 1 })).sfwName).toEqual({
      status: 'unavailable',
    });

    mockPreviewTextScanNsfw.mockResolvedValueOnce({ status: 'unavailable' });
    expect((await checkSfwFace({ sfwName: 'A', userId: 1 })).sfwName).toEqual({
      status: 'unavailable',
    });
  });
});

describe('assertSfwFaceSafe', () => {
  beforeEach(() => {
    mockPreviewTextScanNsfw.mockReset();
  });

  it('refuses a flagged field, naming it', async () => {
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.R));
    await expect(assertSfwFaceSafe({ sfwName: 'x', userId: 1 })).rejects.toThrow('.com title');
  });

  it('refuses to save when the check cannot run', async () => {
    mockPreviewTextScanNsfw.mockRejectedValue(new Error('down'));
    await expect(assertSfwFaceSafe({ sfwName: 'x', userId: 1 })).rejects.toThrow("couldn't check");
  });

  it('lets a clean face through', async () => {
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.PG));
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
    mockPreviewTextScanNsfw.mockReset();
    mockSubmitWorkflow.mockReset();
  });

  it('asks for one revision when the check still flags the draft, quoting its reason', async () => {
    mockSubmitWorkflow
      .mockResolvedValueOnce(draftReply('Nude Pinup Pack', '<p>Retro style.</p>'))
      .mockResolvedValueOnce(draftReply('Retro Pinup Style', '<p>Retro style.</p>'));
    mockPreviewTextScanNsfw.mockImplementation(async ({ fields }: { fields: TextScanField[] }) =>
      fields[0].text?.includes('Nude') ? rated(NsfwLevel.X, 'names nudity') : rated(NsfwLevel.PG)
    );

    const draft = await draftSfwFace({ name: 'Nude Pinup Pack', userId: 1 });

    expect(draft.sfwName).toBe('Retro Pinup Style');
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(2);
    const revision = mockSubmitWorkflow.mock.calls[1][0].body.steps[0].input.messages;
    expect(revision.at(-1).content).toContain('title is still rated X: names nudity');
  });

  it('returns the first draft when it already passes', async () => {
    mockSubmitWorkflow.mockResolvedValueOnce(draftReply('Retro Pinup Style', '<p>ok</p>'));
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.PG));
    await draftSfwFace({ name: 'x', userId: 1 });
    expect(mockSubmitWorkflow).toHaveBeenCalledTimes(1);
  });

  it('refuses with a retryable message when the model gives no usable answer', async () => {
    mockSubmitWorkflow.mockResolvedValueOnce({ data: { status: 'failed', steps: [] } });
    await expect(draftSfwFace({ name: 'x', userId: 1 })).rejects.toThrow("couldn't draft");
  });
});
