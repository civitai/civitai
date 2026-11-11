import { describe, expect, test } from 'vitest';
import { ScanResultCode } from '~/shared/utils/prisma/enums';
import { trainingDataScanServable } from '~/shared/utils/training-data-visibility';

const trainingData = (virusScanResult: ScanResultCode) => ({
  type: 'Training Data',
  virusScanResult,
});

describe('trainingDataScanServable', () => {
  test.each([ScanResultCode.Pending, ScanResultCode.Danger, ScanResultCode.Error])(
    'hides a %s Training Data file from a stranger',
    (scan) => {
      expect(trainingDataScanServable(trainingData(scan), false)).toBe(false);
    }
  );

  test('shows a Pending Training Data file to its owner or a moderator', () => {
    expect(trainingDataScanServable(trainingData(ScanResultCode.Pending), true)).toBe(true);
  });

  test('shows a scanned Training Data file to a stranger', () => {
    expect(trainingDataScanServable(trainingData(ScanResultCode.Success), false)).toBe(true);
  });

  test('leaves other file types alone while their scan is pending', () => {
    expect(
      trainingDataScanServable({ type: 'Model', virusScanResult: ScanResultCode.Pending }, false)
    ).toBe(true);
  });
});
