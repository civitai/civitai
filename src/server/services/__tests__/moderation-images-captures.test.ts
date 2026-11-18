import { describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { FEEDBACK_CAPTURE_OWNER_ID } from '@civitai/shared/feedback-capture';
import { getImagesByUserIdForModeration } from '~/server/services/image.service';

/**
 * The CSAM report page lists the subject's images. A capture the link names is owned by the capture
 * account, so it is added by id; an id naming any other account's image adds nothing.
 */

const whereOf = () => dbMock.dbRead.image.findMany.mock.calls.at(-1)?.[0]?.where;

describe('getImagesByUserIdForModeration', () => {
  it("adds a named id only as a feedback page capture, never another account's image", async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);

    await getImagesByUserIdForModeration(7, [301, 55]);

    expect(whereOf()).toEqual({
      OR: [{ userId: 7 }, { userId: FEEDBACK_CAPTURE_OWNER_ID, id: { in: [301, 55] } }],
    });
  });

  it("lists only the subject's images when the link names none (control)", async () => {
    dbMock.dbRead.image.findMany.mockResolvedValue([]);

    await getImagesByUserIdForModeration(7);

    expect(whereOf()).toEqual({ userId: 7 });
  });
});
