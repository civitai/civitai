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
  projectModelForTool,
  MAX_TOOL_RESULT_ITEMS,
} from '~/server/services/blocks/tools/registry';
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
    name: z.string().min(1).max(64),
    arguments: z.unknown().optional(),
  })
  .strict();

const DEFAULT_LIMIT = 5;

const baseHandler = withAxiom(async function handler(req: NextApiRequest, res: NextApiResponse) {
  const claims = (req as BlockScopedNextApiRequest).blockClaims;
  if (!claims) {
    // withBlockScope only invokes this handler with a valid block JWT; defense
    // in depth, mirroring blocks/models.ts.
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
    res.status(400).json({ error: parsed.error });
    return;
  }

  // ── THE ALLOWLIST. An unregistered name never reaches a handler. `getBlockTool`
  // reads a null-prototype map, so a prototype key (`toString`, `constructor`)
  // returns undefined and is rejected here rather than resolving to a truthy
  // inherited value.
  const tool = getBlockTool(parsed.data.name);
  if (!tool) {
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
    res.status(400).json({
      error: `invalid arguments for tool '${tool.name}': ${args.error.message}`,
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
          res.status(503).json({ error: e.message });
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
