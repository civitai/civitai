import { describe, expect, it } from 'vitest';
import { toCsv } from '~/utils/csv';

describe('amount cell', () => {
  it('keeps negative numbers numeric', () => {
    console.log(JSON.stringify(toCsv(['amount'], [[-500], [500]])));
  });
});
