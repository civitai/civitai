import { describe, expect, it } from 'vitest';
import {
  hashRouteServesEveryone,
  type HashServableCopy,
} from '~/server/services/download-by-hash.servable';

// The terms of findHashCandidates' non-owner branch (download-by-hash.service), one at a time.

const servable: HashServableCopy = {
  fileVisibility: 'Public',
  pickleScanResult: 'Success',
  virusScanResult: 'Success',
  versionStatus: 'Published',
  versionAvailability: 'Public',
  usageControl: 'Download',
  modelStatus: 'Published',
  modelMode: null,
  modelAvailability: 'Public',
  poi: false,
};

describe('hashRouteServesEveryone', () => {
  it('serves a public file on a published, public, downloadable model', () => {
    expect(hashRouteServesEveryone(servable)).toBe(true);
  });

  it.each([
    ['a scan still pending', { pickleScanResult: 'Pending', virusScanResult: 'Pending' }],
    ['a scanner error', { pickleScanResult: 'Error', virusScanResult: 'Error' }],
    ['no scan result yet', { pickleScanResult: null, virusScanResult: null }],
  ] as [string, Partial<HashServableCopy>][])('still serves %s', (_, change) => {
    expect(hashRouteServesEveryone({ ...servable, ...change })).toBe(true);
  });

  it.each([
    ['a non-public file', { fileVisibility: 'Private' }],
    ['a failed pickle scan', { pickleScanResult: 'Danger' }],
    ['a failed virus scan', { virusScanResult: 'Danger' }],
    ['a private version', { versionAvailability: 'Private' }],
    ['a private model', { modelAvailability: 'Private' }],
    ['generation-only use', { usageControl: 'Generation' }],
    ['an archived model', { modelMode: 'Archived' }],
    ['a taken-down model', { modelMode: 'TakenDown' }],
    ['a POI model', { poi: true }],
    ...['Draft', 'Unpublished', 'Scheduled', 'Deleted', 'UnpublishedViolation'].flatMap(
      (status) => [
        [`a ${status} version`, { versionStatus: status }],
        [`a ${status} model`, { modelStatus: status }],
      ]
    ),
  ] as [string, Partial<HashServableCopy>][])('refuses %s', (_, change) => {
    expect(hashRouteServesEveryone({ ...servable, ...change })).toBe(false);
  });
});
