import type { NextApiResponse } from 'next';
import type { Logger } from '@civitai/next-axiom';
import type { NextApiRequest } from 'next';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
// SINGLE SOURCE OF TRUTH: the canonical block-manifest JSON Schema lives at
// `public/schemas/app-block/v1.json` and is served statically at
// https://civitai.com/schemas/app-block/v1.json. This endpoint imports THAT SAME
// FILE and serves it verbatim, so the CORS-accessible `/api/blocks/manifest-schema`
// route can never drift from the canonical (the previous hand-built object did —
// it understated `blockId`/`version` and omitted the enforced `category` +
// `assetBundleUrl` fields). The canonical is machine-guarded to the validator's
// enum sources by the two `*.schema-drift.test.ts` guards, and vendored
// byte-identically by the SDK + Go CLI.
import manifestSchema from '../../../../public/schemas/app-block/v1.json';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * GET /api/blocks/manifest-schema
 *
 * Serves the canonical block-manifest JSON Schema (Draft 2020-12) VERBATIM from
 * `public/schemas/app-block/v1.json` so the `civitai` CLI, editors, and the docs
 * generator can fetch the authoritative contract from a stable, CORS-accessible
 * route. The response body — including its `$id`
 * (`https://civitai.com/schemas/app-block/v1.json`) — is byte-for-byte the
 * canonical document; this endpoint is a CORS/convenience alias for the static
 * file, not a second copy.
 *
 * NOTE (enforcement boundary): the schema describes the manifest SHAPE + enums.
 * The server-side `BlockManifestValidator` additionally enforces SEMANTIC rules
 * JSON Schema can't express — SSRF host allowlisting on iframe.src/assetBundleUrl,
 * scope-subset-of-OAuth-client, sandbox-token-allowlist-by-trust-tier, the
 * buildCommand shape-allowlist, and outputDir traversal — which remain
 * server-authoritative. The schema is a developer convenience for early local
 * feedback; the validator at submit time is the enforcement boundary. If the two
 * ever conflict, the validator wins.
 */
const handler = async (_req: AxiomAPIRequest, res: NextApiResponse) => {
  res.status(200).json(manifestSchema);
};

export default PublicEndpoint(handler, ['GET']);
