import type { NextApiRequest, NextApiResponse } from 'next';
import { withAxiom } from '@civitai/next-axiom';
import * as z from 'zod';

import {
  withBlockScope,
  type BlockScopedNextApiRequest,
} from '~/server/middleware/block-scope.middleware';
import { handleEndpointError } from '~/server/utils/endpoint-helpers';
import { getNextPage } from '~/server/utils/pagination-helpers';
import {
  ModelSearchMeiliTimeoutError,
  resolveModelSearchIds,
  runModelSearch,
} from '~/server/services/model-search.service';
import { resolveCatalogBrowsingLevel } from '~/server/utils/block-catalog-maturity';
import { checkBlockCatalogRateLimit } from '~/server/utils/block-catalog-rate-limit';
import { getRegion, isRegionRestricted } from '~/server/utils/region-blocking';
import {
  blockToolDeclarations,
  boundToolResult,
  getBlockTool,
  neutralizeAirLiterals,
  projectModelForTool,
  MAX_TOOL_RESULT_ITEMS,
} from '~/server/services/blocks/tools/registry';
import { TOOL_NAME_PATTERN } from '~/server/services/blocks/steps/chat-completion.step';
import { MetricTimeframe } from '~/shared/utils/prisma/enums';
import { constants } from '~/server/common/constants';

/**
 * App Blocks TOOL SURFACE (#398 AC5).
 *
 *   GET  /api/v1/blocks/tools   → the read-only tool definitions a block may
 *                                 declare to a chat model.
 *   POST /api/v1/blocks/tools   → body `{ name, arguments }`; executes one
 *                                 registered tool and returns a projected result.
 *
 * Auth: ANY valid block token, no required scope — identical reasoning to
 * `blocks/models.ts`, which this endpoint is a thin, model-shaped view of. The
 * data is public, maturity-clamped catalog content; the token is required for
 * its signed `maxBrowsingLevel` claim, not for authorization.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 🔴 THE CLAMP IS APPLIED HERE, IN THIS HANDLER. It is NOT inherited from the
 * `/api/v1/blocks/*` prefix.
 *
 * `withBlockScope` gives this route the JWT gate, revocation, `private,
 * no-store`, the opaque-origin CORS and the audit row. It does NOT give it the
 * maturity clamp — `blocks/models.ts` states this in its own words, that
 * `resolveCatalogBrowsingLevel` "remains the whole authority surface". A route
 * added under this prefix that forgets the call is UNCLAMPED while looking
 * exactly as protected as its neighbours, and nothing in the wrapper would say
 * so. That is the single most important line in this file, and it is why the
 * suite asserts the clamped level reaches `runModelSearch` with a positive
 * control rather than merely asserting a 200.
 *
 * 🔴 WHY THIS IS NOT AN MCP PROXY. `mcp.civitai.com` exposes the same catalog
 * search, and proxying it would look like less work. Measured: its
 * `search_models` takes no maturity parameter and is `additionalProperties:
 * false`, so the viewer's ceiling cannot be passed IN; and its results carry
 * only `air`/`id`/`name`/`type`, with no maturity metadata, so the ceiling
 * cannot be applied to what comes BACK either. Combined with the clamp not
 * riding on the prefix, a proxy under this path would be an unclamped catalog
 * read. The full reasoning lives in
 * `~/server/services/blocks/tools/registry`'s header.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const config = { api: { bodyParser: { sizeLimit: '8kb' } } };

/**
 * The wire body. `arguments` is deliberately `unknown` here: the per-tool schema
 * in the registry is the real contract, and validating it twice — once loosely
 * at the wire and once strictly per tool — is how the two drift.
 */
const callSchema = z
  .object({
    // 🔴 PATTERN-BOUNDED AT THE WIRE, and not merely for tidiness. Both 400
    // bodies below REFLECT this value back to the caller, and the caller is an
    // untrusted sandboxed iframe that will hand our reply to a chat model as a
    // `role:'tool'` message. `containsAirReference` (the chat step's entitlement
    // guard) throws FORBIDDEN on the literal `urn:air:` ANYWHERE in a submitted
    // step input — so an unbounded `name` lets a caller compose a 400 body it can
    // never replay, with no diagnostic explaining why. The pattern makes the
    // reflection structurally inert instead of relying on the scrub below.
    //
    // Same pattern the chat step enforces on a declared tool name, IMPORTED
    // rather than re-spelled: `registry.ts` already documented the coupling in
    // prose, and a second copy is how the two drift.
    //
    // ⚠️ THE LENGTH BOUND IS STILL A SECOND COPY — the same class this line's
    // `.regex` just closed, one axis over. `64` here is the chat step's
    // `MAX_TOOL_NAME_CHARS` (`~/server/services/blocks/steps/chat-completion.step`),
    // which is module-private, so it cannot be imported today and the two agree
    // only by inspection. Nothing is broken: the values match, and a drift would
    // narrow or widen only what this wire accepts before the registry lookup
    // rejects an unknown name anyway. Closing it means EXPORTING that constant —
    // a source change to a file merged in #4472 — so it is left deliberate and
    // named rather than done as a drive-by here.
    name: z.string().min(1).max(64).regex(TOOL_NAME_PATTERN),
    arguments: z.unknown().optional(),
  })
  .strict();

const DEFAULT_LIMIT = 5;

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // 🔴 THIS IS THE GATE, NOT A BACKSTOP. `withBlockScope` does NOT reject and
    // return on its own in THREE cases — in each it FALLS THROUGH to the wrapped
    // handler with `blockClaims` unset, so deleting these lines does not lose a
    // redundant check, it serves the tool declarations unauthenticated:
    //
    //   1. no bearer token present;
    //   2. a bearer `isBlockJwt` rejects. READ THAT FUNCTION, it is wider than
    //      "not a 3-part JWS": it returns false for anything that is not three
    //      NON-EMPTY dot-separated segments, for a header that fails to
    //      base64url-decode or JSON.parse, AND for a decodable header whose
    //      `alg` is not `RS256` or whose `typ` is not `JWT`. So a well-formed
    //      JWS signed with the wrong alg falls through here too — the legacy
    //      opaque API-key path is one instance of this case, not its definition.
    //      (1) and (2) are one branch, `if (!bearer || !isBlockJwt(bearer))`,
    //      which is why they are easy to count as one;
    //   3. `app-blocks-runtime-enabled` off — including absent, and Flipt down,
    //      which the middleware resolves as false by design.
    //
    // 🔴 COUNT THEM IN THE MIDDLEWARE, NOT HERE. This comment has now been wrong
    // TWICE about this same gate: first calling it "defense in depth", then
    // naming two of the three fall-throughs. Both times the error was restating
    // a remembered shape instead of reading `withBlockScope`. If you touch this,
    // go read the branches.
    //
    // Pinned by its own test; a mutant that removes it previously survived the
    // whole suite, which is why the comment is explicit about what it holds.
    res.status(401).json({ error: 'Block token required' });
    return;
  }

  // ── GET: the declarations. Cheap, no catalog access, no rate limit needed.
  if (req.method === 'GET') {
    res.status(200).json({ tools: blockToolDeclarations() });
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const parsed = callSchema.safeParse(req.body);
  if (!parsed.success) {
    // 🔴 `.message`, NOT the ZodError object. Measured: `JSON.stringify({error:
    // zodError})` emits `{"name":"ZodError","message":"[…issues…]"}`, and those
    // issues echo the caller's own keys verbatim (`"keys":["<their key>"]`). That
    // is caller input rather than server internals — no Prisma table/column, no pg
    // row value — so it is not the disclosure the ledger is named for. It is still
    // an error OBJECT on the wire, and the scrub below is what makes the echo safe
    // to replay rather than the shape being harmless.
    res.status(400).json({
      error: neutralizeAirLiterals(`invalid request body: ${parsed.error.message}`),
    });
    return;
  }

  // ── THE ALLOWLIST. An unregistered name never reaches a handler. `getBlockTool`
  // reads a null-prototype map, so a prototype key (`toString`, `constructor`)
  // returns undefined and is rejected here rather than resolving to a truthy
  // inherited value.
  const tool = getBlockTool(parsed.data.name);
  if (!tool) {
    // Not scrubbed, and it does not need to be: `name` cleared
    // `TOOL_NAME_PATTERN` above, which admits no `:` and therefore cannot carry
    // `urn:air:`. The scrub on the two bodies that CAN echo free text is what
    // does the work; adding one here would imply this reflection is unbounded.
    res.status(400).json({
      error: `unknown tool '${parsed.data.name}'`,
    });
    return;
  }

  // ── PER-TOOL ARGUMENT CONTRACT, strict. This is the SAME schema the served
  // declaration's `parameters` is derived from, so the model cannot be shown a
  // contract this route does not enforce.
  const args = tool.argsSchema.safeParse(parsed.data.arguments ?? {});
  if (!args.success) {
    // SCRUBBED: unlike `name`, an argument value is free text (`query`), and zod
    // echoes offending values and unrecognized keys into `.message`. A caller
    // that sends `query: "urn:air:…"` would otherwise get a 400 body it cannot
    // replay as a `role:'tool'` message.
    res.status(400).json({
      error: neutralizeAirLiterals(
        `invalid arguments for tool '${tool.name}': ${args.error.message}`
      ),
    });
    return;
  }

  // Per-token rate limit, keyed on the stable blockInstanceId — same limiter the
  // catalog endpoint uses, and shared with it deliberately: a block cannot get a
  // second catalog budget by calling the same search through the tool surface.
  // Runs BEFORE the expensive search.
  const rateLimit = await checkBlockCatalogRateLimit(claims.blockInstanceId);
  if (!rateLimit.allowed) {
    res.setHeader('Retry-After', String(rateLimit.retryAfterSeconds));
    res.status(429).json({ error: 'Rate limit exceeded, please retry shortly.' });
    return;
  }

  // 🔴 AUTHORITATIVE CLAMP — see the header. Never the client's; the tool
  // argument schema does not even carry a maturity field to ignore.
  const regionRestricted = isRegionRestricted(getRegion(req));
  const { browsingLevel, isSfwCeiling } = resolveCatalogBrowsingLevel(claims, { regionRestricted });

  try {
    if (tool.name === 'search_models') {
      const { query, type, limit } = args.data as {
        query: string;
        type?: string;
        limit?: number;
      };
      const effectiveLimit = Math.min(limit ?? DEFAULT_LIMIT, MAX_TOOL_RESULT_ITEMS);
      const types = type ? [type] : undefined;

      let searchIds: number[] = [];
      try {
        const meili = await resolveModelSearchIds({
          query,
          limit: effectiveLimit,
          browsingLevel,
          types,
        });
        searchIds = meili.searchIds;
      } catch (e) {
        if (e instanceof ModelSearchMeiliTimeoutError) {
          res.setHeader('Retry-After', '2');
          // 🔴 A LITERAL, NOT `e.message`, AND THAT IS THE POINT — CI caught the
          // difference. `rest-error-envelope-ledger` flags `{ error: <ident>.message }`
          // as a class, because the shape is indistinguishable from serving a
          // DRIVER-authored message (a Prisma error carries table + column; a pg
          // 23505 carries the offending ROW VALUE). Here the value happens to be
          // our own first-party string, so this was over-reporting rather than a
          // live disclosure — but the ledger's own docstring says the remedy for
          // that is a baseline entry, and a brand-new route does not belong in a
          // list of PRE-EXISTING unfixed offenders. Writing the string here costs
          // nothing, removes the offence instead of recording it, and cannot
          // drift if `ModelSearchMeiliTimeoutError`'s text changes.
          //
          // `blocks/models.ts` has the identical `e.message` line and IS
          // baselined. Do not copy it back.
          res.status(503).json({ error: 'Model search is temporarily overloaded — please retry.' });
          return;
        }
        throw e;
      }

      const baseUrlOrigin = getNextPage({ req }).baseUrl.origin;
      const { items } = await runModelSearch(
        {
          types: types as never,
          sort: constants.modelFilterDefaults.sort as never,
          period: MetricTimeframe.AllTime,
          limit: effectiveLimit,
          query,
          searchIds,
          // Same strictness as the catalog endpoint: blocks stay strict on both
          // the minor and the maturity axis.
          disableMinor: true,
        },
        {
          // CLAMPED — never the client's, and no passthrough that could widen it.
          browsingLevel,
          nsfwImagePassthrough: false,
          user: undefined,
          baseUrlOrigin,
        }
      );

      const projected = items
        .map((item) => projectModelForTool(item))
        .filter((m): m is NonNullable<typeof m> => m !== null);
      const bounded = boundToolResult(projected);

      res.status(200).json({
        tool: tool.name,
        result: bounded,
        // Advisory, exactly as the catalog endpoint echoes it — the clamp itself
        // is authoritative and already applied.
        maturity: { browsingLevel, sfwOnly: isSfwCeiling },
      });
      return;
    }

    // Unreachable while the registry has one entry, and a compile-visible place
    // to notice when a second is added without a dispatch arm.
    res.status(500).json({ error: `tool '${tool.name}' has no dispatch implementation` });
    return;
  } catch (e) {
    handleEndpointError(res, e);
    return;
  }
});

// No requiredScope — any valid block token, exactly as blocks/models.ts. The
// maturity clamp in the handler is the whole authority surface.
// allowOpaqueOrigin: an UNVERIFIED block runs at an opaque origin (`Origin:
// null`) and calls this directly from the sandboxed iframe, so it needs
// `ACAO: null` to clear the CORS preflight.
export default withBlockScope(baseHandler, { endpoint: 'tools', allowOpaqueOrigin: true });
