import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import type { BareNotification } from '~/server/notifications/base.notifications';
import { populateNotificationDetails } from '~/server/notifications/detail-fetchers';
import { getNotificationMessage } from '~/server/notifications/utils.notifications';

const findMany = dbMock.dbRead.model.findMany;

// What `Model` holds: model 7 has a .com face, model 8 does not.
const models = [
  { id: 7, sfwName: 'Com title' },
  { id: 8, sfwName: null },
];

function notification(type: string, details: Record<string, unknown>): BareNotification {
  return { id: 1, type, details };
}

describe('model face on notifications', () => {
  beforeEach(() => {
    findMany.mockClear();
    findMany.mockImplementation(
      async ({ where }: { where: { id: { in: number[] }; sfwName?: { not: null } } }) => {
        // As Prisma does: an int filter refuses a value that is not a number.
        if (where.id.in.some((id) => typeof id !== 'number')) throw new Error('Invalid id');
        return models.filter(
          (model) => where.id.in.includes(model.id) && (!where.sfwName || model.sfwName !== null)
        );
      }
    );
  });

  it.each([
    ['new-model-version', { modelId: 7, modelName: 'Red title', versionName: 'v2' }],
    ['featured-model', { modelId: 7, modelName: 'Red title' }],
    ['new-mention', { mentionedIn: 'model', modelId: 7, modelName: 'Red title', username: 'u' }],
  ])(
    'renders the .com title in a %s notification for a reader who gets the face',
    async (type, details) => {
      const n = notification(type, details);
      await populateNotificationDetails([n], { showSfwFace: true });

      expect(getNotificationMessage(n)?.message).toContain('Com title');
      expect(getNotificationMessage(n)?.message).not.toContain('Red title');
    }
  );

  it('keeps the stored name of a model without a face', async () => {
    const n = notification('new-model-version', {
      modelId: 8,
      modelName: 'Plain',
      versionName: 'v1',
    });
    await populateNotificationDetails([n], { showSfwFace: true });

    expect(n.details.modelName).toBe('Plain');
  });

  it('keeps the stored name for a reader who sees mature content', async () => {
    const n = notification('new-model-version', {
      modelId: 7,
      modelName: 'Red title',
      versionName: 'v2',
    });
    await populateNotificationDetails([n], { showSfwFace: false });

    expect(n.details.modelName).toBe('Red title');
  });

  it('skips a modelId that is not a number instead of failing the page', async () => {
    const n = notification('featured-model', { modelId: '7', modelName: 'Red title' });
    await populateNotificationDetails([n], { showSfwFace: true });

    expect(n.details.modelName).toBe('Red title');
  });
});
