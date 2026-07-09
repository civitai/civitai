import type { NextApiResponse } from 'next';
import type { Logger } from '@civitai/next-axiom';
import type { NextApiRequest } from 'next';
import { PublicEndpoint } from '~/server/utils/endpoint-helpers';
import {
  ALLOWED_CONTENT_RATINGS,
  ALLOWED_RENDER_MODES,
  ALLOWED_TRUST_TIERS,
} from '~/server/services/block-manifest-validator.service';

type AxiomAPIRequest = NextApiRequest & { log: Logger };

/**
 * GET /api/blocks/manifest-schema
 *
 * Publishes the canonical block-manifest JSON Schema (Draft 2020-12) so the
 * `civitai` CLI can fetch the authoritative contract instead of vendoring a copy
 * that drifts from the server's `BlockManifestValidator`.
 *
 * NOTE (single-source caveat): this schema describes the manifest SHAPE +
 * enums and is kept in step with the validator by importing the validator's enum
 * sets directly (so an enum can't drift). The validator additionally enforces
 * SEMANTIC rules JSON Schema can't express — SSRF host allowlisting on
 * iframe.src, scope-subset-of-OAuth-client, sandbox-token-allowlist-by-trust-tier,
 * buildCommand shape-allowlist, outputDir traversal — which remain
 * server-authoritative. The schema is a developer convenience for early local
 * feedback; the validator at submit time is the enforcement boundary. If the two
 * ever conflict, the validator wins.
 */
const handler = async (_req: AxiomAPIRequest, res: NextApiResponse) => {
  res.status(200).json(MANIFEST_JSON_SCHEMA);
};

const MANIFEST_JSON_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://civitai.com/api/blocks/manifest-schema',
  title: 'Civitai App Block Manifest',
  type: 'object',
  additionalProperties: true,
  required: ['blockId', 'version', 'name', 'contentRating', 'scopes'],
  properties: {
    blockId: { type: 'string', minLength: 1 },
    version: { type: 'string', minLength: 1 },
    name: { type: 'string', minLength: 1 },
    contentRating: { type: 'string', enum: [...ALLOWED_CONTENT_RATINGS] },
    renderMode: { type: 'string', enum: [...ALLOWED_RENDER_MODES], default: 'iframe' },
    // trustTier is SERVER-OWNED: a submitted value is ignored/overridden by the
    // server. Documented here for completeness but developers should not rely on
    // setting it.
    trustTier: {
      type: 'string',
      enum: [...ALLOWED_TRUST_TIERS],
      description: 'Server-owned; submitted values are overridden by the server.',
    },
    scopes: {
      type: 'array',
      items: { type: 'string', pattern: '^[a-z0-9_]+(?::[a-z0-9_]+){1,3}$' },
    },
    iframe: {
      type: 'object',
      // iframe.src is SERVER-OWNED at registration (normalized + host-allowlisted
      // server-side). Required for renderMode=iframe.
      properties: {
        src: { type: 'string', format: 'uri' },
        minHeight: { type: 'number', minimum: 40, maximum: 4000 },
        maxHeight: { type: ['number', 'null'], minimum: 40, maximum: 4000 },
        resizable: { type: 'boolean' },
        sandbox: { type: 'string', minLength: 1 },
      },
    },
    publicSettingsKeys: {
      type: 'array',
      maxItems: 32,
      items: { type: 'string', minLength: 1, maxLength: 64 },
    },
    targets: {
      type: 'array',
      maxItems: 16,
      items: {
        type: 'object',
        required: ['slotId'],
        properties: { slotId: { type: 'string', minLength: 1 } },
      },
    },
    page: {
      type: 'object',
      required: ['path', 'title'],
      properties: {
        path: { type: 'string', minLength: 1, maxLength: 256, pattern: '^/' },
        title: { type: 'string', minLength: 1, maxLength: 128 },
        icon: { type: 'string', maxLength: 128 },
        buzzBudgetPerGen: { type: 'integer', exclusiveMinimum: 0 },
      },
    },
    // Config-as-code (CLI page-vite template). Optional + backward-compatible.
    buildCommand: {
      type: 'string',
      maxLength: 128,
      // Mirrors BUILD_COMMAND_RE in the validator. The server ALSO rejects shell
      // metacharacters separately; this pattern is the positive allowlist.
      pattern: '^(?:(?:npm|pnpm|yarn) run [a-zA-Z0-9:_-]+|(?:npx )?vite build)$',
      description:
        'Allowed build invocation run in the isolated build sandbox. e.g. "npm run build", "pnpm run <script>", "vite build", "npx vite build".',
    },
    outputDir: {
      type: 'string',
      minLength: 1,
      maxLength: 256,
      description: 'Safe relative output dir (no leading "/", no "..", default "dist").',
      default: 'dist',
    },
  },
} as const;

export default PublicEndpoint(handler, ['GET']);
