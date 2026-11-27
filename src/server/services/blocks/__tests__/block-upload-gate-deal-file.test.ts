import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { gateBlockUploadImage } from '~/server/services/blocks/block-image-upload.service';
import { dealCopyCheckFor } from '~/server/services/__tests__/deal-file-copy.fake';

const OWNER = 7;
const user = { id: OWNER, isModerator: false } as Parameters<
  typeof gateBlockUploadImage
>[0]['user'];

beforeEach(() => {
  dbMock.dbRead.image.findUnique.mockResolvedValue({
    id: 1,
    userId: OWNER,
    url: 'key',
    ingestion: 'Pending',
    nsfwLevel: 0,
    needsReview: null,
    poi: false,
    minor: false,
    tosViolation: false,
  } as never);
});

const pointedAt = (pointed: boolean) =>
  dbMock.dbWrite.$queryRaw.mockImplementation(dealCopyCheckFor(pointed ? 1 : -1));

describe('gateBlockUploadImage', () => {
  it("refuses the caller's own image when it is a deal file's scan copy", async () => {
    pointedAt(true);
    await expect(gateBlockUploadImage({ imageId: 1, user })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });

  it('gates an ordinary owned image on its scan (control)', async () => {
    pointedAt(false);
    await expect(gateBlockUploadImage({ imageId: 1, user })).resolves.toEqual({
      status: 'pending',
    });
  });
});
