import { describe, expect, it, vi, beforeEach } from 'vitest';
import { TRPCError } from '@trpc/server';

/**
 * Error mapping for the blob-archive step. The archive call reaches the orchestrator
 * over the network, so an upstream 5xx or a status-less transport failure is a
 * dependency outage — a retry-able 503, not a 500 against our own SLO — and whatever
 * detail the orchestrator gave has to survive into the message we surface.
 */

const { mockInvoke } = vi.hoisted(() => ({ mockInvoke: vi.fn() }));

vi.mock('@civitai/client', () => ({ invokeBlobArchiveStepTemplate: mockInvoke }));
vi.mock('~/server/services/orchestrator/client', () => ({ internalOrchestratorClient: {} }));

import { createBlobArchive } from '~/server/services/orchestrator/blobArchive';

const entries = [{ blobId: 'A.safetensors', fileName: 'a.safetensors' }];

// The generated client RESOLVES `{ data: undefined, error }` on an error response;
// it only REJECTS when the request never got a response at all.
const errorResolve = (error: Record<string, unknown>) => ({ data: undefined, error });

beforeEach(() => vi.clearAllMocks());

describe('createBlobArchive error mapping', () => {
  it('maps an upstream 5xx to a retry-able 503, keeping the client error as cause', async () => {
    const upstream = { status: 502, detail: 'bad gateway' };
    mockInvoke.mockResolvedValue(errorResolve(upstream));

    const thrown = await createBlobArchive({ entries }).catch((e) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown.code).toBe('SERVICE_UNAVAILABLE');
    // tRPC re-wraps a non-Error cause, so match on the carried fields rather than identity.
    expect(thrown.cause).toMatchObject(upstream);
  });

  it('maps a status-less network failure to a retry-able 503', async () => {
    mockInvoke.mockRejectedValue(new TypeError('fetch failed'));

    const thrown = await createBlobArchive({ entries }).catch((e) => e);

    expect(thrown).toBeInstanceOf(TRPCError);
    expect(thrown.code).toBe('SERVICE_UNAVAILABLE');
  });

  it('lets an unrecognized rejection bubble as-is rather than calling it an outage', async () => {
    const bug = new TypeError("Cannot read properties of undefined (reading 'map')");
    mockInvoke.mockRejectedValue(bug);

    await expect(createBlobArchive({ entries })).rejects.toBe(bug);
  });

  it('keeps the orchestrator detail in the message on an unclassified failure', async () => {
    mockInvoke.mockResolvedValue(errorResolve({ detail: 'blob A.safetensors is unreadable' }));

    const thrown = await createBlobArchive({ entries }).catch((e) => e);

    expect(thrown.code).toBe('INTERNAL_SERVER_ERROR');
    expect(thrown.message).toBe('blob A.safetensors is unreadable');
  });

  it('prefers the structured validation messages over `detail` on a 400', async () => {
    mockInvoke.mockResolvedValue(
      errorResolve({ status: 400, detail: 'ignored', errors: { messages: ['too many entries'] } })
    );

    const thrown = await createBlobArchive({ entries }).catch((e) => e);

    expect(thrown.code).toBe('BAD_REQUEST');
    expect(thrown.message).toBe('too many entries');
  });

  it('maps a non-400 4xx to BAD_REQUEST instead of a 500', async () => {
    mockInvoke.mockResolvedValue(errorResolve({ status: 404, detail: 'blob not found' }));

    const thrown = await createBlobArchive({ entries }).catch((e) => e);

    expect(thrown.code).toBe('BAD_REQUEST');
    expect(thrown.message).toBe('blob not found');
  });
});
