import { describe, it, expect, vi } from 'vitest';

vi.mock('@civitai/client', () => ({
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn(),
  updateWorkflow: vi.fn(),
  handleError: vi.fn(),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
  refreshBlob: vi.fn().mockImplementation(({ path }) => {
    return Promise.resolve({
      data: {
        url: `https://orchestration.civitai.com/v2/consumer/blobs/${path.blobId}.jpeg?sig=new-sig&exp=2030-01-01T00:00:00.000Z`,
      },
    });
  }),
}));

import {
  shouldRefreshBlobUrl,
  findBlobUrls,
  refreshBlobUrlsInBody,
} from '../workflows';

import { refreshBlob } from '@civitai/client';

describe('shouldRefreshBlobUrl', () => {
  it('should return false for standard non-blob URLs', () => {
    expect(shouldRefreshBlobUrl('https://image.civitai.com/xG1nkqKTMzGDvpLrqFT7WA/abc.jpeg')).toBe(false);
    expect(shouldRefreshBlobUrl('https://google.com')).toBe(false);
  });

  it('should return true if signature or expiry is missing from consumer blob URL', () => {
    expect(shouldRefreshBlobUrl('https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg')).toBe(true);
    expect(shouldRefreshBlobUrl('https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=123')).toBe(true);
    expect(shouldRefreshBlobUrl('https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?exp=2026-06-07T10:00:00Z')).toBe(true);
  });

  it('should return true if the URL signature has already expired or expires in < 5 mins', () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString(); // 1 min ago
    expect(
      shouldRefreshBlobUrl(
        `https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=123&exp=${expiredTime}`
      )
    ).toBe(true);

    const expiringSoonTime = new Date(Date.now() + 2 * 60 * 1000).toISOString(); // 2 mins from now
    expect(
      shouldRefreshBlobUrl(
        `https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=123&exp=${expiringSoonTime}`
      )
    ).toBe(true);
  });

  it('should return false if signature is valid and expires far in the future', () => {
    const validTime = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour from now
    expect(
      shouldRefreshBlobUrl(
        `https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=123&exp=${validTime}`
      )
    ).toBe(false);
  });
});

describe('findBlobUrls', () => {
  it('should extract blob URLs and return correct paths in simple and nested structures', () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString();
    const data = {
      prompt: 'a prompt',
      images: [
        {
          url: `https://orchestration.civitai.com/v2/consumer/blobs/BLOB1.jpeg?sig=123&exp=${expiredTime}`,
          width: 512,
        },
        {
          url: 'https://image.civitai.com/valid-cdn/abc.jpeg',
          width: 512,
        },
      ],
      sourceImage: {
        url: `https://orchestration.civitai.com/v2/consumer/blobs/BLOB2.png?sig=abc&exp=${expiredTime}`,
      },
    };

    const result = findBlobUrls(data);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      path: ['images', '0', 'url'],
      blobId: 'BLOB1',
    });
    expect(result).toContainEqual({
      path: ['sourceImage', 'url'],
      blobId: 'BLOB2',
    });
  });
});

describe('refreshBlobUrlsInBody', () => {
  it('should replace expired blob URLs in workflow body with fresh ones', async () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString();
    const body = {
      steps: [
        {
          $type: 'imageGen',
          input: {
            images: [
              `https://orchestration.civitai.com/v2/consumer/blobs/BLOB1.jpeg?sig=123&exp=${expiredTime}`,
            ],
          },
        },
      ],
    };

    const client = {};
    await refreshBlobUrlsInBody(body, client);

    expect(refreshBlob).toHaveBeenCalledWith({
      client,
      path: { blobId: 'BLOB1' },
    });

    expect(body.steps[0].input.images[0]).toBe(
      'https://orchestration.civitai.com/v2/consumer/blobs/BLOB1.jpeg?sig=new-sig&exp=2030-01-01T00:00:00.000Z'
    );
  });
});
