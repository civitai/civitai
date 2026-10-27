import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import { updateUserById } from '~/server/services/user.service';

/**
 * The updated user row is what a profile save and a ban hand back to the client. The legacy billing
 * pointer on it must stay server-side. The fake honours `omit` the way Prisma does.
 */

const ROW = { id: 7, name: 'zzfixture', subscriptionId: 'sub_zzfixture', customerId: null };

beforeEach(() => {
  vi.mocked(dbMock.dbWrite.user.update).mockImplementation((async (args: {
    omit?: Record<string, boolean>;
  }) => Object.fromEntries(Object.entries(ROW).filter(([key]) => !args.omit?.[key]))) as never);
});

describe('updateUserById', () => {
  it('returns the updated row without its subscription id', async () => {
    const user = await updateUserById({ id: ROW.id, data: { name: 'zzfixture' } });

    expect(user).toMatchObject({ id: ROW.id, name: 'zzfixture' });
    expect(user).not.toHaveProperty('subscriptionId');
  });
});
