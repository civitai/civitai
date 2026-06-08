import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WorkflowTemplate } from '@civitai/client';

// Mock throwBadRequestError from errorHandling to test error propagation
vi.mock('~/server/utils/errorHandling', () => ({
  throwBadRequestError: vi.fn().mockImplementation((msg) => new Error(msg)),
  throwAuthorizationError: vi.fn().mockImplementation((msg) => new Error(msg)),
  throwInsufficientFundsError: vi.fn().mockImplementation((msg) => new Error(msg)),
  throwInternalServerError: vi.fn().mockImplementation((msg) => new Error(msg)),
}));

// Mock @civitai/client
vi.mock('@civitai/client', () => ({
  addWorkflowTag: vi.fn(),
  deleteWorkflow: vi.fn(),
  getWorkflow: vi.fn(),
  patchWorkflow: vi.fn(),
  queryWorkflows: vi.fn(),
  removeWorkflowTag: vi.fn(),
  submitWorkflow: vi.fn().mockResolvedValue({ data: { id: 'wf-id' } }),
  updateWorkflow: vi.fn(),
  handleError: vi.fn(),
  createCivitaiClient: vi.fn().mockReturnValue({
    getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
  }),
  refreshBlob: vi.fn().mockImplementation(({ path }) => {
    if (path.blobId === 'FAIL_BLOB') {
      return Promise.reject(new Error('API Error'));
    }
    return Promise.resolve({
      data: {
        url: `https://orchestration.civitai.com/v2/consumer/blobs/${path.blobId}?sig=new-sig&exp=2030-01-01T00:00:00.000Z`,
      },
    });
  }),
}));

import {
  shouldRefreshBlobUrl,
  findBlobUrls,
  refreshBlobUrlsInBody,
  submitWorkflow,
} from '../workflows';

import { refreshBlob, submitWorkflow as clientSubmitWorkflow } from '@civitai/client';

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

  it('should return true if exp param is not a valid date', () => {
    expect(
      shouldRefreshBlobUrl(
        'https://orchestration.civitai.com/v2/consumer/blobs/abc.jpeg?sig=123&exp=not-a-date'
      )
    ).toBe(true);
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
          url: `https://orchestration.civitai.com/v2/consumer/blobs/BLOB-1_id.jpeg?sig=123&exp=${expiredTime}`,
          width: 512,
        },
        {
          url: 'https://image.civitai.com/valid-cdn/abc.jpeg',
          width: 512,
        },
      ],
      sourceImage: {
        url: `https://orchestration.civitai.com/v2/consumer/blobs/BLOB_2-id.png?sig=abc&exp=${expiredTime}`,
      },
    };

    const result = findBlobUrls(data);
    expect(result).toHaveLength(2);
    expect(result).toContainEqual({
      path: ['images', '0', 'url'],
      blobId: 'BLOB-1_id.jpeg',
    });
    expect(result).toContainEqual({
      path: ['sourceImage', 'url'],
      blobId: 'BLOB_2-id.png',
    });
  });

  it('should stop traversing beyond a depth of 20 levels to prevent stack overflow', () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString();
    const deepObj: any = {};
    let current = deepObj;
    // Create 25 levels of nesting
    for (let i = 0; i < 25; i++) {
      current.next = {};
      current = current.next;
    }
    current.url = `https://orchestration.civitai.com/v2/consumer/blobs/DEEPBLOB?sig=123&exp=${expiredTime}`;

    const result = findBlobUrls(deepObj);
    expect(result).toHaveLength(0); // Exceeded maxDepth guard of 20, should be skipped
  });
});

describe('refreshBlobUrlsInBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should replace expired blob URLs in workflow body with fresh ones', async () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString();
    const body: WorkflowTemplate = {
      steps: [
        {
          $type: 'imageGen',
          input: {
            images: [
              `https://orchestration.civitai.com/v2/consumer/blobs/BLOB1.jpeg?sig=123&exp=${expiredTime}`,
            ],
          },
        },
      ] as any,
    };

    const client = {
      getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
    } as any;
    await refreshBlobUrlsInBody(body, client);

    expect(refreshBlob).toHaveBeenCalledWith({
      client,
      path: { blobId: 'BLOB1.jpeg' },
    });

    const stepInput = body.steps[0].input as any;
    expect(stepInput.images[0]).toBe(
      'https://orchestration.civitai.com/v2/consumer/blobs/BLOB1.jpeg?sig=new-sig&exp=2030-01-01T00:00:00.000Z'
    );
  });

  it('should propagate and raise throwBadRequestError if refreshing fails', async () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString();
    const body: WorkflowTemplate = {
      steps: [
        {
          $type: 'imageGen',
          input: {
            images: [
              `https://orchestration.civitai.com/v2/consumer/blobs/FAIL_BLOB?sig=123&exp=${expiredTime}`,
            ],
          },
        },
      ] as any,
    };

    const client = {
      getConfig: () => ({ baseUrl: 'https://orchestration.civitai.com' }),
    } as any;

    await expect(refreshBlobUrlsInBody(body, client)).rejects.toThrow(
      'Failed to refresh image URL for blob: FAIL_BLOB. Please try uploading the image again.'
    );
  });
});

describe('submitWorkflow (mocked)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should refresh stale blob URLs in steps automatically when calling submitWorkflow', async () => {
    const expiredTime = new Date(Date.now() - 60 * 1000).toISOString();
    const body: WorkflowTemplate = {
      steps: [
        {
          $type: 'imageGen',
          input: {
            images: [
              `https://orchestration.civitai.com/v2/consumer/blobs/BLOBINTEG?sig=123&exp=${expiredTime}`,
            ],
          },
        },
      ] as any,
    };

    await submitWorkflow({
      token: 'test-token',
      body,
    });

    // Verify it called refreshBlob
    expect(refreshBlob).toHaveBeenCalledWith({
      client: expect.any(Object),
      path: { blobId: 'BLOBINTEG' },
    });

    // Verify clientSubmitWorkflow was called with refreshed body
    expect(clientSubmitWorkflow).toHaveBeenCalledWith({
      client: expect.any(Object),
      body: expect.objectContaining({
        steps: [
          expect.objectContaining({
            input: expect.objectContaining({
              images: [
                'https://orchestration.civitai.com/v2/consumer/blobs/BLOBINTEG?sig=new-sig&exp=2030-01-01T00:00:00.000Z',
              ],
            }),
          }),
        ],
      }),
      query: undefined,
    });
  });
});
