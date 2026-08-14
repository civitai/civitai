import { getGenerationDataSchema } from '~/server/schema/generation.schema';
import { getGenerationData } from '~/server/services/generation/generation.service';
import { handleEndpointError, PublicEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { getRequestDomainColor } from '~/server/utils/server-domain';

export default PublicEndpoint(
  async function handler(req, res) {
    try {
      const session = await getServerAuthSession({ req, res });

      // 🔴 civitai#3845 TIER 1. The catch below used to answer EVERY failure with
      // `400 { message: e.message }` on a `PublicEndpoint`, so a
      // `throwDbError`-wrapped driver error reached anonymous callers verbatim.
      //
      // The fix is NOT a blind delegation, because this catch had two populations
      // in it and only one of them is a disclosure:
      //
      //   • a zod rejection of `req.query` — feedback WE wrote about the caller's
      //     own query string. It discloses nothing, and turning it into a 500 would
      //     fix a leak by breaking the API contract for every client that sends a
      //     bad `?type=`. `safeParse` lifts it OUT of the catch entirely, so the
      //     split is structural rather than an `instanceof` inside the handler —
      //     which a ZodError re-thrown from deeper in the service would defeat.
      //     `result.error.message` is the SAME string `parse()` threw, so this 400
      //     is byte-identical to the pre-fix one.
      //
      //   • anything thrown past the parse — a service or driver failure whose
      //     message nobody wrote for a caller. That delegates.
      //
      // Ordered after `getServerAuthSession` on purpose: that call came first
      // before, and a session lookup that throws must keep landing in the catch
      // rather than being pre-empted by a query rejection.
      const queryInput = getGenerationDataSchema.safeParse(req.query);
      if (!queryInput.success) return res.status(400).json({ message: queryInput.error.message });

      const queryResult = await getGenerationData({
        query: queryInput.data,
        user: session?.user,
        sfwOnly: getRequestDomainColor(req) === 'green',
      });
      return res.status(200).json(queryResult);
    } catch (e) {
      if (res.headersSent) return;
      // Status semantics change here, deliberately: a `throwNotFoundError` from
      // `getMediaGenerationData` now answers 404 instead of 400, and a
      // `throwAuthorizationError` 401 instead of 400 — both with the same
      // `{ message }` body the helper's 4xx arm emits. The two hand-written
      // `throw new Error(...)` client rejections in `generation.service.ts` were
      // converted to `throwBadRequestError` in the same commit so they KEEP their
      // 400 and their exact text instead of collapsing into a generic 500.
      return handleEndpointError(res, e);
    }
  },
  ['GET']
);
