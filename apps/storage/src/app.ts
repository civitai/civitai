import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { ZodType } from 'zod';
import {
  abortMultipartInput,
  classifyS3MultipartError,
  completeMultipartInput,
  createMultipartInput,
  deleteManyObjectsInput,
  deleteObjectInput,
  headObjectInput,
  presignGetInput,
  presignMultipartInput,
  presignPartInput,
  presignPutInput,
  type S3MultipartErrorClass,
  type StorageBackend,
} from '@civitai/storage';
import { isAuthorized } from './lib/server/auth';
import { getBackendClient } from './lib/server/backends';
import { b2PresignIssued, registry } from './lib/server/metrics';
import { logLevel } from './env';

// A failed complete/abort is classified and returned with a distinct status so the client (and the
// shimmed main-app handlers) get the right terminal/retry behavior instead of a blanket 500 the client
// would then retry — re-amplifying NoSuchUpload/InvalidPart storms.
const MULTIPART_ERROR_STATUS: Record<S3MultipartErrorClass, number> = {
  'not-found': 404,
  'invalid-parts': 422,
  transient: 503,
  other: 500,
};

/**
 * Build the Fastify server (no listen — server.ts calls listen; tests use `.inject`).
 * Ops routes: GET /health (no-dep liveness), GET /metrics (private-by-XFF).
 * Authed API (bearer token), all POST, mirroring the monolith's s3-utils network ops:
 *   - /objects/delete, /objects/delete-many, /objects/head
 *   - /presign/put, /presign/get, /presign/multipart
 *   - /multipart/create, /multipart/presign-part (streaming), /multipart/complete, /multipart/abort
 * The service holds the bucket credentials; a caller names a `backend` and the service resolves creds.
 */
export async function buildServer(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: logLevel }, trustProxy: true });

  app.get('/health', async () => ({ status: 'ok', service: 'storage' }));

  // EXPOSURE GUARD: any request carrying x-forwarded-for came through the public ingress; the in-cluster
  // ServiceMonitor scrapes the Pod IP directly with NO XFF. So XFF present ⇒ 404.
  app.get('/metrics', async (req, reply) => {
    if (req.headers['x-forwarded-for'] !== undefined) {
      return reply.code(404).type('text/plain').send('Not Found');
    }
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });

  // Shared gate + zod validation for every authed POST. Returns the parsed body, or null after having
  // already sent the 401/400 response.
  function authedBody<T>(schema: ZodType<T>, req: FastifyRequest, reply: FastifyReply): T | null {
    if (!isAuthorized(req.headers)) {
      reply.code(401).send({ error: 'Unauthorized' });
      return null;
    }
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'Invalid payload', issues: parsed.error.issues });
      return null;
    }
    return parsed.data;
  }

  // Wrap an authed handler: parse+auth, run, and map a backend/config error to 500 with a logged reason.
  function route<T>(
    schema: ZodType<T>,
    handler: (body: T, reply: FastifyReply) => Promise<unknown>
  ) {
    return async (req: FastifyRequest, reply: FastifyReply) => {
      const body = authedBody(schema, req, reply);
      if (body === null) return reply;
      try {
        return await handler(body, reply);
      } catch (err) {
        req.log.error({ err }, 'storage op failed');
        return reply.code(500).send({ error: 'Internal error' });
      }
    };
  }

  // Count ONE presigned-upload issuance per upload for the B2 backends (reproduces the monolith's
  // b2_presign_issued: one per single PUT, one per multipart upload — sized at /presign/multipart,
  // streaming at /multipart/create — never per part). Always labeled with the RESOLVED bucket.
  function countPresign(backend: StorageBackend, bucket: string) {
    if (backend === 'b2' || backend === 'b2Image') b2PresignIssued.inc({ backend, bucket });
  }

  app.post(
    '/objects/delete',
    route(deleteObjectInput, async (body) => {
      await getBackendClient(body.backend).deleteObject(body.key, body.bucket);
      return { ok: true };
    })
  );

  app.post(
    '/objects/delete-many',
    route(deleteManyObjectsInput, async (body) => {
      await getBackendClient(body.backend).deleteManyObjects(body.keys, body.bucket);
      return { ok: true };
    })
  );

  app.post(
    '/objects/head',
    route(headObjectInput, async (body) => {
      return getBackendClient(body.backend).headObject(body.key, body.bucket);
    })
  );

  app.post(
    '/presign/put',
    route(presignPutInput, async (body) => {
      const result = await getBackendClient(body.backend).getPutUrl(body.key, {
        bucket: body.bucket,
        expiresIn: body.expiresIn,
      });
      countPresign(body.backend, result.bucket);
      return result;
    })
  );

  app.post(
    '/presign/get',
    route(presignGetInput, async (body, reply) => {
      const client = getBackendClient(body.backend);
      if (body.url) {
        return client.getGetUrl(body.url, {
          bucket: body.bucket,
          expiresIn: body.expiresIn,
          fileName: body.fileName,
        });
      }
      if (body.key) {
        return client.getGetUrlByKey(body.key, {
          bucket: body.bucket,
          expiresIn: body.expiresIn,
          fileName: body.fileName,
        });
      }
      return reply.code(400).send({ error: 'presign/get requires `key` or `url`' });
    })
  );

  app.post(
    '/presign/multipart',
    route(presignMultipartInput, async (body) => {
      const result = await getBackendClient(body.backend).getMultipartPutUrl(body.key, body.size, {
        bucket: body.bucket,
        mimeType: body.mimeType,
        chunkSize: body.chunkSize,
        expiresIn: body.expiresIn,
      });
      countPresign(body.backend, result.bucket);
      return result;
    })
  );

  // --- streaming multipart (create + presign each part on demand) ---
  app.post(
    '/multipart/create',
    route(createMultipartInput, async (body) => {
      const result = await getBackendClient(body.backend).createMultipartUpload(body.key, {
        bucket: body.bucket,
        mimeType: body.mimeType,
      });
      countPresign(body.backend, result.bucket); // one count per streaming upload, resolved bucket
      return result;
    })
  );

  app.post(
    '/multipart/presign-part',
    route(presignPartInput, async (body) => {
      return getBackendClient(body.backend).presignUploadPart(
        body.key,
        body.uploadId,
        body.partNumber,
        {
          bucket: body.bucket,
          expiresIn: body.expiresIn,
        }
      );
    })
  );

  // complete/abort classify their S3 error and return a distinct status (see MULTIPART_ERROR_STATUS) —
  // deliberately NOT via `route()`, whose blanket 500 would erase the class and trigger client retries.
  app.post('/multipart/complete', async (req, reply) => {
    const body = authedBody(completeMultipartInput, req, reply);
    if (body === null) return reply;
    try {
      await getBackendClient(body.backend).completeMultipartUpload(
        body.key,
        body.uploadId,
        body.parts,
        body.bucket
      );
      return reply.send({ ok: true });
    } catch (err) {
      const cls = classifyS3MultipartError(err);
      req.log.error({ err, class: cls }, 'multipart complete failed');
      return reply
        .code(MULTIPART_ERROR_STATUS[cls])
        .send({ error: 'multipart complete failed', class: cls });
    }
  });

  app.post('/multipart/abort', async (req, reply) => {
    const body = authedBody(abortMultipartInput, req, reply);
    if (body === null) return reply;
    try {
      await getBackendClient(body.backend).abortMultipartUpload(
        body.key,
        body.uploadId,
        body.bucket
      );
      return reply.send({ ok: true });
    } catch (err) {
      const cls = classifyS3MultipartError(err);
      req.log.error({ err, class: cls }, 'multipart abort failed');
      return reply
        .code(MULTIPART_ERROR_STATUS[cls])
        .send({ error: 'multipart abort failed', class: cls });
    }
  });

  return app;
}
