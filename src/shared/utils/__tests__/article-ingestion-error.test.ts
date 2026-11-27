import { describe, expect, it } from 'vitest';
import {
  articleIngestionErrorReason,
  ingestionErrorNotice,
} from '~/shared/utils/article-ingestion-error';

describe('articleIngestionErrorReason', () => {
  it.each([
    [{ errorImages: 0, missingImages: 0, textError: false }, null],
    [{ errorImages: 2, missingImages: 0, textError: false }, '2 image(s) could not be scanned'],
    [{ errorImages: 0, missingImages: 1, textError: false }, null],
    [
      { errorImages: 0, missingImages: 1, textError: true },
      'the text check could not finish. 1 image(s) could not be found and are left out of the article',
    ],
    [
      { errorImages: 1, missingImages: 1, textError: true },
      '1 image(s) could not be scanned and the text check could not finish. 1 image(s) could not be found and are left out of the article',
    ],
  ])('%o: %s', (input, reason) => {
    expect(articleIngestionErrorReason(input)).toBe(reason);
  });
});

describe('ingestionErrorNotice', () => {
  it('promises a retry only while the retries still run', () => {
    expect(ingestionErrorNotice({ reason: 'x', retrying: true })).toContain('retry automatically');
    expect(ingestionErrorNotice({ reason: 'x', retrying: false })).not.toContain('retry');
  });

  it('names no scan failure for an article held for review', () => {
    expect(ingestionErrorNotice({ reason: null, retrying: true })).not.toContain(
      'could not finish'
    );
  });
});
