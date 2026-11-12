import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { getCaptureReportContext } from '~/server/services/feedback-capture-report.service';

/** What the subject picker for a capture's CSAM report is built from. */

beforeEach(() => {
  dbMock.dbRead.user.findUnique.mockResolvedValue({ username: 'reporter' } as never);
  dbMock.dbRead.feedback.findUnique.mockResolvedValue({
    context: { path: '/images/123' },
  } as never);
});

const image = (userId: number, metadata: unknown) =>
  dbMock.dbRead.image.findUnique.mockResolvedValue({ id: 5, userId, metadata } as never);

describe('getCaptureReportContext', () => {
  it("names the capture's reporter and report from its server stamp", async () => {
    image(FEEDBACK_CAPTURE_OWNER_ID, { feedbackCapture: { feedbackId: 9, reporterId: 7 } });

    expect(await getCaptureReportContext(5)).toEqual({
      imageId: 5,
      feedbackId: 9,
      reporterId: 7,
      reporterUsername: 'reporter',
      path: '/images/123',
    });
    expect(dbMock.dbRead.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 7 } })
    );
  });

  it('is null for an image that is not a capture, whatever its metadata says', async () => {
    image(42, { feedbackCapture: { feedbackId: 9, reporterId: 7 } });

    expect(await getCaptureReportContext(5)).toBeNull();
  });

  it('names no reporter when the stamp is missing', async () => {
    image(FEEDBACK_CAPTURE_OWNER_ID, null);

    expect(await getCaptureReportContext(5)).toMatchObject({
      feedbackId: null,
      reporterId: null,
      path: null,
    });
  });

  it('names no reporter or report the stamp gives as anything but a positive id', async () => {
    image(FEEDBACK_CAPTURE_OWNER_ID, { feedbackCapture: { feedbackId: 0, reporterId: '7; drop' } });

    expect(await getCaptureReportContext(5)).toMatchObject({ feedbackId: null, reporterId: null });
  });
});
