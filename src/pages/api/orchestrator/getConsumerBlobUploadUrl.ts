import { TRPCError } from '@trpc/server';
import { getConsumerBlobUploadUrlService } from '~/server/services/orchestrator/consumerBlobUpload';
import { OrchestratorEndpoint } from '~/server/utils/endpoint-helpers';

// The client retries only 429/5xx, so an upstream outage must not arrive as a 403 denial.
function presignErrorStatus(e: unknown) {
  if (e instanceof TRPCError) {
    if (e.code === 'UNAUTHORIZED') return 403;
    if (e.code === 'BAD_REQUEST') return 400;
    if (e.code === 'TOO_MANY_REQUESTS') return 429;
  }
  return 502;
}

export default OrchestratorEndpoint(
  async function handler(req, res, user, token) {
    try {
      const result = await getConsumerBlobUploadUrlService({ token });
      return res.status(200).json(result);
    } catch (e) {
      const status = presignErrorStatus(e);
      // Only the 4xx texts are written for the user; an upstream failure's may not be.
      return res
        .status(status)
        .send(status === 502 ? 'Failed to get upload URL' : (e as Error).message);
    }
  },
  ['GET']
);
