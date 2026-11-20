import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startPglitePrisma } from '~/__tests__/pglite-prisma';
import { connectionImageExists } from '~/server/selectors/image.selector';

// Production's ImageConnection has no foreign key to Image, so this table has none either.
const SCHEMA = `
  CREATE TABLE "Image" (id int PRIMARY KEY, url text NOT NULL);
  CREATE TABLE "ImageConnection" (
    "imageId" int NOT NULL,
    "entityId" int NOT NULL,
    "entityType" text NOT NULL,
    PRIMARY KEY ("imageId", "entityType", "entityId")
  );
  INSERT INTO "Image" (id, url) VALUES (1, 'kept');
  INSERT INTO "ImageConnection" ("imageId", "entityId", "entityType") VALUES
    (1, 10, 'Bounty'), (2, 10, 'Bounty');
`;

let harness: Awaited<ReturnType<typeof startPglitePrisma>>;
beforeAll(async () => {
  harness = await startPglitePrisma(SCHEMA);
});
afterAll(() => harness.stop());

const read = (where: object) =>
  harness.prisma.imageConnection.findMany({
    where: { entityType: 'Bounty', entityId: 10, ...where },
    select: { image: { select: { id: true, url: true } } },
  });

describe('an ImageConnection whose image was deleted', () => {
  it('fails a read that includes the image (control)', async () => {
    await expect(read({})).rejects.toThrow(/Field image is required to return data/);
    await harness.recover();
  });

  it('is skipped by a read that requires the image to exist', async () => {
    expect(await read(connectionImageExists)).toEqual([{ image: { id: 1, url: 'kept' } }]);
  });
});
