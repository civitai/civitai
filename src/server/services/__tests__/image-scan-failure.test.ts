import { describe, it, expect } from 'vitest';
import {
  classifyImageScanFailure,
  getImageScanRetryLimit,
  ImageScanFailureClass,
  IMAGE_SCAN_TRANSIENT_RETRY_LIMIT,
  IMAGE_SCAN_UNKNOWN_RETRY_LIMIT,
  IMAGE_SCAN_PERMANENT_RETRY_LIMIT,
} from '~/server/services/image-scan-failure';

describe('classifyImageScanFailure', () => {
  it('classifies container-create churn as transient', () => {
    expect(
      classifyImageScanFailure({
        reason: 'Failed to create container. Giving up after 10 attempts',
        failureType: 'workflow-failed',
        failedSteps: ['tags'],
      })
    ).toBe(ImageScanFailureClass.Transient);
  });

  it('classifies a worker 5xx as transient', () => {
    expect(
      classifyImageScanFailure({
        reason: 'Response status code does not indicate success: 500 (Internal Server Error).',
        failureType: 'workflow-failed',
        failedSteps: ['tags'],
      })
    ).toBe(ImageScanFailureClass.Transient);
  });

  it('classifies workflow expiry as transient regardless of reason', () => {
    expect(
      classifyImageScanFailure({ failureType: 'expired', reason: null, failedSteps: [] })
    ).toBe(ImageScanFailureClass.Transient);
  });

  it('classifies a PrepareManagedContainer middleware failure as transient', () => {
    expect(
      classifyImageScanFailure({
        reason: 'something went wrong',
        middleware: 'PrepareManagedContainer',
        failureType: 'workflow-failed',
      })
    ).toBe(ImageScanFailureClass.Transient);
  });

  it('classifies a download/decode failure as permanent', () => {
    expect(
      classifyImageScanFailure({
        reason: 'Failed to download the media from the provided url',
        failureType: 'workflow-failed',
        failedSteps: ['rating'],
      })
    ).toBe(ImageScanFailureClass.Permanent);
    expect(
      classifyImageScanFailure({
        reason: 'Unable to decode image: unsupported format',
        failureType: 'workflow-failed',
      })
    ).toBe(ImageScanFailureClass.Permanent);
  });

  it('prefers transient when a 5xx occurs during a download (avoids permanent mislabel)', () => {
    expect(
      classifyImageScanFailure({
        reason: 'Failed to download: 500 Internal Server Error',
        failureType: 'workflow-failed',
      })
    ).toBe(ImageScanFailureClass.Transient);
  });

  it('falls back to unknown for an unrecognized reason', () => {
    expect(
      classifyImageScanFailure({
        reason: 'some brand new error nobody has seen before',
        failureType: 'workflow-failed',
        failedSteps: ['tags'],
      })
    ).toBe(ImageScanFailureClass.Unknown);
  });

  it('falls back to unknown when no reason/steps are available', () => {
    expect(
      classifyImageScanFailure({ reason: null, failureType: 'workflow-failed', failedSteps: [] })
    ).toBe(ImageScanFailureClass.Unknown);
  });

  it('is case-insensitive', () => {
    expect(
      classifyImageScanFailure({
        reason: 'FAILED TO CREATE CONTAINER',
        failureType: 'workflow-failed',
      })
    ).toBe(ImageScanFailureClass.Transient);
  });
});

describe('getImageScanRetryLimit', () => {
  it('maps each class to its ceiling', () => {
    expect(getImageScanRetryLimit(ImageScanFailureClass.Transient)).toBe(
      IMAGE_SCAN_TRANSIENT_RETRY_LIMIT
    );
    expect(getImageScanRetryLimit(ImageScanFailureClass.Permanent)).toBe(
      IMAGE_SCAN_PERMANENT_RETRY_LIMIT
    );
    expect(getImageScanRetryLimit(ImageScanFailureClass.Unknown)).toBe(
      IMAGE_SCAN_UNKNOWN_RETRY_LIMIT
    );
  });

  it('defaults to the conservative unknown cap for null/unrecognized classes', () => {
    expect(getImageScanRetryLimit(null)).toBe(IMAGE_SCAN_UNKNOWN_RETRY_LIMIT);
    expect(getImageScanRetryLimit(undefined)).toBe(IMAGE_SCAN_UNKNOWN_RETRY_LIMIT);
    expect(getImageScanRetryLimit('bogus')).toBe(IMAGE_SCAN_UNKNOWN_RETRY_LIMIT);
  });

  it('keeps transient strictly above the historical unknown cap and permanent minimal', () => {
    expect(IMAGE_SCAN_TRANSIENT_RETRY_LIMIT).toBeGreaterThan(IMAGE_SCAN_UNKNOWN_RETRY_LIMIT);
    expect(IMAGE_SCAN_PERMANENT_RETRY_LIMIT).toBeLessThan(IMAGE_SCAN_UNKNOWN_RETRY_LIMIT);
  });
});
