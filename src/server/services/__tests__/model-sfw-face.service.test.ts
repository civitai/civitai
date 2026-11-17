import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NsfwLevel } from '~/server/common/enums';
import type * as TextScanPreview from '~/server/services/text-scan/preview';
import type { TextScanField } from '~/server/services/text-scan/types';

const { mockPreviewTextScanNsfw, mockPreviewComFaceIntent, mockSubmitWorkflow } = vi.hoisted(
  () => ({
    mockPreviewTextScanNsfw: vi.fn(),
    mockPreviewComFaceIntent: vi.fn(),
    mockSubmitWorkflow: vi.fn(),
  })
);

// The package's ESM build can't be loaded by `importOriginal` here; every suite fakes it whole.
vi.mock('@civitai/orchestration-client', () => ({
  createCivitaiClient: vi.fn(() => ({})),
  submitWorkflow: mockSubmitWorkflow,
}));

vi.mock('~/server/services/text-scan/preview', async (importOriginal) => ({
  ...(await importOriginal<typeof TextScanPreview>()),
  previewTextScanNsfw: mockPreviewTextScanNsfw,
  previewComFaceIntent: mockPreviewComFaceIntent,
}));

import {
  assertSfwFaceSafe,
  checkSfwFace,
  COM_FACE_CHECK_UNAVAILABLE_MESSAGE,
  COM_FACE_REFUSED_EDIT_MESSAGE,
  draftSfwFace,
} from '~/server/services/model-sfw-face.service';

const intent = (detected: boolean) => ({ status: 'ok', output: { detected, reason: 'stub' } });
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
    mockPreviewComFaceIntent.mockReset().mockResolvedValue(intent(false));
  });

  it('refuses a flagged field, naming it', async () => {
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.R));
    await expect(assertSfwFaceSafe({ sfwName: 'x', name: 'n', userId: 1 })).rejects.toThrow(
      '.com title'
    );
  });

  it('refuses to save when the check cannot run', async () => {
    mockPreviewTextScanNsfw.mockRejectedValue(new Error('down'));
    await expect(assertSfwFaceSafe({ sfwName: 'x', name: 'n', userId: 1 })).rejects.toThrow(
      "couldn't check"
    );
  });

  it('lets a clean face through', async () => {
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.PG));
    await expect(
      assertSfwFaceSafe({
        sfwName: 'Retro Pinup Style',
        sfwDescription: '<p>ok</p>',
        name: 'n',
        userId: 1,
      })
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
    mockPreviewComFaceIntent.mockReset().mockResolvedValue(intent(false));
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

// Fails closed: a check that cannot run refuses.
describe('the .com face intent gate', () => {
  beforeEach(() => {
    mockPreviewTextScanNsfw.mockReset().mockResolvedValue(rated(NsfwLevel.PG));
    mockPreviewComFaceIntent.mockReset();
    mockSubmitWorkflow.mockReset();
  });

  it('refuses a draft for a flagged model before drafting anything', async () => {
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(draftSfwFace({ name: 'n', userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_EDIT_MESSAGE
    );
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it("names the fields it read in a refusal, never the check's reason", async () => {
    mockPreviewComFaceIntent.mockResolvedValue({
      status: 'ok',
      output: { detected: true, reason: 'CHECK-REASON-TEXT' },
    });
    const error = await assertSfwFaceSafe({ sfwName: 'Retro', name: 'n', userId: 1 }).catch(
      (e: Error) => e
    );
    expect((error as Error).message).toBe(COM_FACE_REFUSED_EDIT_MESSAGE);
    expect((error as Error).message).toMatch(/title, description and trigger words/);
  });

  it('refuses a hand-typed face on a flagged model at save, though its own text is clean', async () => {
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    await expect(
      assertSfwFaceSafe({ sfwName: 'Retro Pinup Style', name: 'n', userId: 1 })
    ).rejects.toThrow(COM_FACE_REFUSED_EDIT_MESSAGE);
  });

  it('gives the listing refusal when the .com text is flagged too', async () => {
    mockPreviewComFaceIntent.mockResolvedValue(intent(true));
    mockPreviewTextScanNsfw.mockResolvedValue(rated(NsfwLevel.X));
    await expect(assertSfwFaceSafe({ sfwName: 'Nude Pack', name: 'n', userId: 1 })).rejects.toThrow(
      COM_FACE_REFUSED_EDIT_MESSAGE
    );
  });

  it.each([
    [
      'gives no verdict',
      () => mockPreviewComFaceIntent.mockResolvedValue({ status: 'unavailable' }),
    ],
    ['throws', () => mockPreviewComFaceIntent.mockRejectedValue(new Error('down'))],
  ])('refuses draft and save when the check %s', async (_, arrange) => {
    arrange();
    await expect(draftSfwFace({ name: 'n', userId: 1 })).rejects.toThrow(
      COM_FACE_CHECK_UNAVAILABLE_MESSAGE
    );
    await expect(
      assertSfwFaceSafe({ sfwName: 'Retro Pinup Style', name: 'n', userId: 1 })
    ).rejects.toThrow(COM_FACE_CHECK_UNAVAILABLE_MESSAGE);
    expect(mockSubmitWorkflow).not.toHaveBeenCalled();
  });

  it('checks the model listing, not the new .com text', async () => {
    mockPreviewComFaceIntent.mockResolvedValue(intent(false));
    await assertSfwFaceSafe({
      sfwName: 'Retro Pinup Style',
      name: 'Red Title',
      description: '<p>Red <b>description</b></p>',
      userId: 1,
    });
    const text = fieldText(mockPreviewComFaceIntent.mock.calls[0]);
    expect(text).toContain('Red Title');
    expect(text).toContain('Red description');
    expect(text).not.toContain('Retro Pinup Style');
  });
});
