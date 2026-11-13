import { beforeEach, describe, expect, it } from 'vitest';
import { dbMock } from '~/__tests__/mocks/db.mock';
import {
  CREATOR_JOURNEY_CONFIG_KEY,
  getCreatorJourneyConfig,
} from '~/server/services/creator-journey-config.service';

const ROLE = '1000000000000000001';
const findUnique = dbMock.dbRead.keyValue.findUnique;

beforeEach(() => {
  findUnique.mockReset();
});

describe('getCreatorJourneyConfig', () => {
  it('reads its own KeyValue row', async () => {
    findUnique.mockResolvedValue(null);
    await getCreatorJourneyConfig();
    expect(findUnique).toHaveBeenCalledWith({ where: { key: CREATOR_JOURNEY_CONFIG_KEY } });
  });

  // One bad field must not take the others with it: a typo in a role id would otherwise also
  // silence the staff alert sitting beside it.
  it('drops only the malformed field', async () => {
    findUnique.mockResolvedValue({
      value: { supernovaRoleId: ROLE, legendRoleId: 'not-a-snowflake', legendAlertUserIds: [1] },
    });
    expect(await getCreatorJourneyConfig()).toEqual({
      supernovaRoleId: ROLE,
      legendAlertUserIds: [1],
    });
  });

  it('rejects a numeric role id, which would lose precision in JSON', async () => {
    findUnique.mockResolvedValue({ value: { legendRoleId: 1e18 } });
    expect(await getCreatorJourneyConfig()).toEqual({});
  });

  it('accepts Discord ids of 17 to 20 digits only', async () => {
    findUnique.mockResolvedValue({
      value: {
        supernovaRoleId: '1'.repeat(17),
        legendRoleId: '1'.repeat(20),
        legendsChannelId: '1'.repeat(16),
      },
    });
    expect(await getCreatorJourneyConfig()).toEqual({
      supernovaRoleId: '1'.repeat(17),
      legendRoleId: '1'.repeat(20),
    });
    findUnique.mockResolvedValue({ value: { legendRoleId: '1'.repeat(21) } });
    expect(await getCreatorJourneyConfig()).toEqual({});
  });

  it('accepts up to 20 alert recipients, as positive integer user ids', async () => {
    const twenty = Array.from({ length: 20 }, (_, i) => i + 1);
    findUnique.mockResolvedValue({ value: { legendAlertUserIds: twenty } });
    expect(await getCreatorJourneyConfig()).toEqual({ legendAlertUserIds: twenty });
    for (const bad of [[0], [-1], [1.5]]) {
      findUnique.mockResolvedValue({ value: { legendAlertUserIds: bad } });
      expect(await getCreatorJourneyConfig()).toEqual({});
    }
  });

  it('rejects an alert list longer than 20 recipients', async () => {
    findUnique.mockResolvedValue({
      value: { legendAlertUserIds: Array.from({ length: 21 }, (_, i) => i + 1) },
    });
    expect(await getCreatorJourneyConfig()).toEqual({});
  });

  it('is empty for a missing row or a non-object value', async () => {
    findUnique.mockResolvedValue(null);
    expect(await getCreatorJourneyConfig()).toEqual({});
    findUnique.mockResolvedValue({ value: 'supernovaRoleId' });
    expect(await getCreatorJourneyConfig()).toEqual({});
  });
});
