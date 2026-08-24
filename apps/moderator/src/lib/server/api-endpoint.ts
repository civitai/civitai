import { z } from 'zod';
import { error, json, type RequestEvent } from '@sveltejs/kit';
import { requireAccess } from './access';
import type { EndpointDoc } from './api-guard';

// ENDPOINT DEFINITIONS — one declaration per HTTP method, replacing a hand-written `_doc` beside a
// hand-rolled validation block that could disagree with it:
//
//   export const POST = defineWebhookEndpoint({
//     summary: 'Save the edited prose as the next policy version.',
//     input: z.object({ policy: z.string().min(1).describe('The policy prose.') }),
//     handler: async ({ policy }) => ({ saved: true }),
//   });
//
// The schema IS the documentation — /xguard/docs reads `spec` off the handler, so a param cannot be
// documented and not validated, or validated and not documented.
//
// Two builders rather than one with an `auth` option, because who may call is not a detail of an
// endpoint, it is the first thing about it — and because the two need different things:
//
//   defineWebhookEndpoint — a service holding WEBHOOK_TOKEN. A moderator's browser session is REFUSED,
//     matching the main app's WebhookEndpoint. Nobody is behind the call, so it can attribute nothing,
//     which is what keeps `human_judgement` out of reach.
//   defineEndpoint — a signed-in moderator holding the `page` grant. A token is refused.
//
// There is no separate guard to remember: defining an endpoint is what authenticates it.

/** Set by the builder, never by the author — the catalog reports how an endpoint authenticates. */
export type EndpointAuth = { kind: 'webhook' } | { kind: 'session'; page: string };

export type EndpointSpec = {
  auth: EndpointAuth;
  summary: string;
  input?: z.ZodType;
  returns?: string;
  notes?: string[];
};

type Definition<S extends z.ZodType, E extends RequestEvent> = {
  summary: string;
  input?: S;
  returns?: string;
  notes?: string[];
  /** Return a `Response` to control status/headers (201, 202); anything else is serialised as 200 JSON. */
  handler: (input: z.output<S>, event: E) => unknown;
};

// Path params win over query, which wins over the body: the path names the resource, so a body field
// that disagrees with it is a caller mistake rather than an override. Query and path values are always
// STRINGS — schemas reading them need `z.coerce`.
async function collectInput(event: RequestEvent): Promise<Record<string, unknown>> {
  const hasBody = event.request.method !== 'GET' && event.request.method !== 'HEAD';
  let body: unknown;
  if (hasBody && event.request.headers.get('content-length') !== '0') {
    try {
      body = await event.request.json();
    } catch {
      body = undefined; // an unparseable body surfaces as a schema error, not a 500
    }
  }
  return {
    ...(body && typeof body === 'object' ? (body as Record<string, unknown>) : {}),
    ...Object.fromEntries(event.url.searchParams),
    ...event.params,
  };
}

function build<S extends z.ZodType, E extends RequestEvent>(
  def: Definition<S, E>,
  auth: EndpointAuth,
  authenticate: (event: E) => void
) {
  const handle = async (event: E) => {
    authenticate(event);
    const raw = await collectInput(event);

    let input = raw as z.output<S>;
    if (def.input) {
      const parsed = def.input.safeParse(raw);
      // Returned rather than thrown so the caller gets the field-level issues; `error()` carries only a
      // message, which for a script is the difference between a fix and a guess.
      if (!parsed.success)
        return json({ error: 'Invalid request', issues: parsed.error.issues }, { status: 400 });
      input = parsed.data as z.output<S>;
    }

    const result = await def.handler(input, event);
    return result instanceof Response ? result : json(result as Record<string, unknown>);
  };

  const spec: EndpointSpec = {
    auth,
    summary: def.summary,
    input: def.input,
    returns: def.returns,
    notes: def.notes,
  };
  return Object.assign(handle, { spec });
}

/** Service-authenticated: a verified WEBHOOK_TOKEN, set by hooks.server.ts. No user. */
export function defineWebhookEndpoint<S extends z.ZodType, E extends RequestEvent>(
  def: Definition<S, E>
) {
  return build(def, { kind: 'webhook' }, (event) => {
    if (event.locals.tokenClient !== 'webhook')
      error(401, 'Send a valid service token as `?token=` or `Authorization: Bearer <token>`.');
  });
}

/**
 * Moderator-authenticated. `page` is the NAVIGATION path whose grant this endpoint borrows — an endpoint
 * reachable by someone who cannot open the corresponding page is a permission fork waiting to drift.
 */
export function defineEndpoint<S extends z.ZodType, E extends RequestEvent>(
  def: Definition<S, E> & { page: string }
) {
  return build(def, { kind: 'session', page: def.page }, (event) => {
    // A token is refused rather than ignored: it would otherwise reach here with no user and 401 as
    // "not signed in", which reads like the caller forgot a cookie rather than used the wrong scheme.
    if (event.locals.tokenClient)
      error(401, 'This endpoint is for signed-in moderators, not services.');
    if (!event.locals.user) error(401, 'Not signed in.');
    requireAccess(event.locals.user, def.page);
  });
}

// Render a spec as the shape /xguard/docs already displays. Params come from the schema via zod's
// JSON-Schema projection, so the documented contract is the enforced one — the drift the docs page's
// generated endpoint list was built to avoid, closed for params too.
export function specToDoc(spec: EndpointSpec): EndpointDoc {
  if (!spec.input) return { summary: spec.summary, returns: spec.returns, notes: spec.notes };

  const schema = z.toJSONSchema(spec.input, { io: 'input' }) as {
    properties?: Record<string, { type?: string; description?: string; default?: unknown }>;
    required?: string[];
  };
  const required = new Set(schema.required ?? []);

  return {
    summary: spec.summary,
    params: Object.entries(schema.properties ?? {}).map(([name, p]) => ({
      name,
      type: p.type ?? 'unknown',
      required: required.has(name),
      description:
        p.default !== undefined
          ? `${p.description ?? ''} Defaults to ${JSON.stringify(p.default)}.`.trim()
          : p.description ?? '',
    })),
    returns: spec.returns,
    notes: spec.notes,
  };
}
