import { beforeEach, describe, expect, it, vi } from 'vitest';
import { loggingMock } from '~/__tests__/mocks/logging.mock';
import { clickhouseFailSoftCounter } from '~/server/prom/client';
import { runClickHouseRead } from '~/server/utils/errorHandling';

const inc = vi.mocked(clickhouseFailSoftCounter.inc);
const logToAxiom = vi.mocked(loggingMock.logToAxiom);

describe('runClickHouseRead — clickhouseFailSoftCounter', () => {
  beforeEach(() => {
    inc.mockClear();
    logToAxiom.mockClear();
  });

  it('does NOT count an UNKNOWN_TABLE fault (Code: 60)', async () => {
    const original = new Error(
      'ClickHouse query failed: Code: 60. DB::Exception: Table orchestration.resourceCompensations does not exist'
    );
    const err = await runClickHouseRead(() => Promise.reject(original), {
      path: 'model-version-generations',
    }).catch((e) => e);
    expect(err).toBe(original);
    expect(inc).not.toHaveBeenCalled();
  });
});
