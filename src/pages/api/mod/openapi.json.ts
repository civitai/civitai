import { sessionCookieName } from '@civitai/auth';
import type { NextApiResponse } from 'next';
import { ModEndpoint } from '~/server/utils/endpoint-helpers';
import type { CatalogEntry } from '~/server/utils/moderator-endpoint-catalog';
import { moderatorEndpointCatalog } from '~/server/utils/moderator-endpoint-catalog';
import { getBaseUrl } from '~/server/utils/url-helpers';

// The moderator API as an OpenAPI 3.1 document.
//
// This is the seam Swagger's architecture is actually about: the DOCUMENT is the artifact, and renderers
// are clients of it. `/moderator/api` can fetch this instead of reading specs out of modules itself, and
// the same document feeds anything else that wants the contract — Scalar or Swagger UI, a generated
// client for the moderator app, or a CI diff that catches a breaking change to a parameter.
//
// It is built from the same specs the endpoints validate against, and `z.toJSONSchema` output IS an
// OpenAPI 3.1 schema object, so no second description of any endpoint exists to drift.
//
// Deliberately a MINIMAL valid subset — paths, operations, parameters/requestBody, security, the error
// responses the wrapper actually returns. Not full OpenAPI fidelity; claiming that would be a lie that
// a generator downstream would discover the hard way.
//
// `ModEndpoint`, not `defineModeratorEndpoint`: reading documentation is not a moderation action, and
// routing it through the wrapper would write an audit row every time the reference page loads. It still
// accepts a moderator API key as well as a session, because `getServerAuthSession` resolves a bearer
// token — so a script or CI job can fetch this without a browser.

type Operation = Record<string, unknown>;

/** `/api/mod/homeblock/create` -> `homeblock`. Tags give Swagger-style grouping that matches the
 *  sections on /moderator/api, rather than a second, different grouping. */
const tagOf = (path: string) => path.split('/')[3] ?? 'mod';

function operationFor(entry: CatalogEntry): Operation | null {
  if (!entry.doc) return null;
  const { doc, schema } = entry;
  const isGet = doc.method === 'GET';
  const properties = schema?.properties ?? {};
  const required = new Set(schema?.required ?? []);

  const op: Operation = {
    operationId: entry.name,
    summary: doc.summary,
    tags: [tagOf(entry.path)],
    responses: {
      200: { description: doc.returns ?? 'Success' },
      400: { description: 'Invalid request — the response carries per-field issues.' },
      401: { description: 'Not signed in, or the API key did not resolve.' },
      403: doc.privileged
        ? { description: `Not a moderator, or missing the "${doc.privileged}" permission.` }
        : { description: 'Not a moderator.' },
      429: { description: 'Rate limit exceeded for this actor.' },
    },
    // Extensions rather than prose: a client generator ignores them, and a human reading the document
    // still learns the limit and the permission without opening the handler.
    'x-rate-limit': doc.rateLimit,
    ...(doc.privileged ? { 'x-privileged': doc.privileged } : {}),
  };

  if (doc.notes?.length) op.description = doc.notes.join('\n\n');

  if (isGet) {
    // GET takes its input in the query string; every value arrives as a string, which is why the
    // schemas coerce. The projected schema is passed through per-parameter unchanged.
    op.parameters = Object.entries(properties).map(([name, prop]) => ({
      name,
      in: 'query',
      required: required.has(name),
      ...(prop.description ? { description: prop.description } : {}),
      schema: prop,
    }));
  } else if (schema) {
    op.requestBody = {
      required: (schema.required ?? []).length > 0,
      content: { 'application/json': { schema } },
    };
  }

  return op;
}

export default ModEndpoint(
  async (_req, res: NextApiResponse) => {
    const catalog = await moderatorEndpointCatalog();

    const paths: Record<string, Record<string, Operation>> = {};
    const unavailable: { path: string; reason: string }[] = [];

    for (const entry of catalog) {
      const op = operationFor(entry);
      if (!op || !entry.doc) {
        // Reported in the document rather than dropped, for the same reason the page shows it: an endpoint
        // absent from the contract reads as an endpoint that does not exist.
        unavailable.push({
          path: entry.path,
          reason: entry.loadError ?? 'Could not be described.',
        });
        continue;
      }
      paths[entry.path] = { [entry.doc.method.toLowerCase()]: op };
    }

    const document = {
      openapi: '3.1.0',
      info: {
        title: 'Civitai moderator API',
        version: '1.0.0',
        description: [
          'Endpoints behind the moderator tools. Every one resolves to a real moderator: a browser',
          'session, that same session forwarded by a first-party spoke, or a moderator API key.',
          '',
          'Generated from the zod schemas the endpoints validate against — there is no second',
          'description of an endpoint that could drift from the first.',
        ].join('\n'),
      },
      servers: [{ url: getBaseUrl() }],
      components: {
        securitySchemes: {
          sessionCookie: { type: 'apiKey', in: 'cookie', name: sessionCookieName() },
          moderatorApiKey: {
            type: 'http',
            scheme: 'bearer',
            description: "A moderator's own API key.",
          },
        },
      },
      // Either scheme satisfies any operation — two entries, not one entry with two keys, which would
      // mean "both at once".
      security: [{ sessionCookie: [] }, { moderatorApiKey: [] }],
      paths,
      ...(unavailable.length ? { 'x-unavailable': unavailable } : {}),
    };

    // Short cache: the document only changes on deploy, but a stale one is a lying contract, so this is
    // measured in seconds rather than left to a CDN default.
    res.setHeader('Cache-Control', 'private, max-age=30');
    return res.status(200).json(document);
  },
  ['GET']
);
