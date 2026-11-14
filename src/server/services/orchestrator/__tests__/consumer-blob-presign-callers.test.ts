import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every place that mints a consumer blob upload URL, the client or token it mints with, and where
// that value comes from. A consumer upload carries the user's own media, so it is minted with that
// user's orchestrator token: the upload is then attributed to and processed for the user. The shared
// system client mints a presign that carries no user.
// Each entry is `<argument> <- <its binding in the enclosing function>`, or `(not bound locally)` when the
// value arrives as a parameter; UPSTREAM below pins what each parameter is fed with.
// Adding, removing or changing an entry is a review decision, not a test fix.
const SDK_CALLS: Record<string, string[]> = {
  'apps/training-studio/src/lib/orchestrator-core.ts': ['client <- (not bound locally)'],
  'src/server/services/orchestrator/consumerBlobUpload.ts': [
    'client <- createOrchestratorClient(token)',
  ],
};

// Callers of getConsumerBlobUploadUrlService, the token each passes, and its binding.
const SERVICE_CALLS: Record<string, string[]> = {
  'src/pages/api/orchestrator/getConsumerBlobUploadUrl.ts': ['token <- (not bound locally)'],
  // App Blocks batch upload (OPEN_MEDIA_UPLOAD_BATCH): `token` is a parameter, fed below.
  'src/server/services/blocks/media-upload-batch.service.ts': ['token <- (not bound locally)'],
  'src/server/services/training.service.ts': ['token <- await getUserToken()'],
};

// Where each parameter or getter above is fed from, as whitespace-normalised source that must be
// present. Behaviour for the training wizard's getter is pinned by the router test too.
const UPSTREAM: [file: string, source: string][] = [
  // OrchestratorEndpoint hands its handler the caller's own token.
  [
    'src/pages/api/orchestrator/getConsumerBlobUploadUrl.ts',
    'OrchestratorEndpoint( async function handler(req, res, user, token) {',
  ],
  // The App Blocks batch presign procedure: the token subject's own token.
  [
    'src/server/routers/blocks.router.ts',
    'const token = await getOrchestratorToken(userId, ctx); const { uploadUrl, expiresAt } = await presignMediaUploadBatchItem({ actor: { userId, appBlockId: claims.appBlockId }, batchId: input.batchId, index: input.index, token, });',
  ],
  // The training wizard's auto-label upload.
  [
    'src/server/routers/training.router.ts',
    'getUserToken: () => getOrchestratorToken(ctx.user.id, ctx),',
  ],
  // Training Studio: the app's own session token, and the embed's host token.
  [
    'apps/training-studio/src/lib/server/orchestrator.ts',
    'return core.blobUploadUrl(orchestratorClient(token));',
  ],
  [
    'apps/training-studio/src/lib/element/backend.ts',
    'return await call((client) => orch.blobUploadUrl(client));',
  ],
];

const SYSTEM_CREDENTIALS = /internalOrchestratorClient|ORCHESTRATOR_ACCESS_TOKEN/;

const root = join(__dirname, '../../../../..');
const SKIP_DIRS = new Set([
  'node_modules',
  '__tests__',
  '.svelte-kit',
  '.next',
  '.output',
  '.turbo',
  'coverage',
  'dist',
  'build',
]);

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    if (!entry.isFile()) return [];
    return /\.(tsx?|svelte)$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

const SDK_IMPORT =
  /import\s*\{[^}]*\bgetConsumerBlobUploadUrl\b[^}]*\}\s*from\s*['"]@civitai\/orchestration-client['"]/;

const normalise = (text: string) => text.replace(/\s+/g, ' ');

/**
 * The `client` (or `token`) argument of each call and its binding in the enclosing function, or a
 * marker for a call shape not read here.
 */
function callArguments(text: string, callee: string, key: string): string[] {
  const calls = [...text.matchAll(new RegExp(`\\b${callee}\\(`, 'g'))];
  return calls.map((call) => {
    const at = call.index ?? 0;
    const rest = text.slice(at + call[0].length);
    const m = rest.match(new RegExp(`^\\s*\\{\\s*${key}\\s*(?::\\s*([\\w.$]+))?\\s*[,}]`));
    if (!m) return '<unread call shape>';
    const arg = m[1] ?? key;
    const before = text.slice(0, at);
    const fnStart = Math.max(before.lastIndexOf('function '), before.lastIndexOf('function('));
    const body = before.slice(Math.max(fnStart, 0));
    const name = arg.replace(/[.$]/g, '\\$&');
    const bindings = [
      ...body.matchAll(new RegExp(`\\b(?:const|let|var)\\s+${name}\\s*=\\s*([^;]+);`, 'g')),
    ];
    const binding = bindings.at(-1)?.[1];
    return `${arg} <- ${binding ? normalise(binding).trim() : '(not bound locally)'}`;
  });
}

describe('consumer blob upload URLs', () => {
  const sdk: Record<string, string[]> = {};
  const service: Record<string, string[]> = {};
  const definition = 'src/server/services/orchestrator/consumerBlobUpload.ts';

  for (const base of ['src', 'apps', 'packages']) {
    for (const file of sourceFiles(join(root, base))) {
      const path = relative(root, file).replaceAll('\\', '/');
      const text = readFileSync(file, 'utf8');

      // An alias or a namespace import would hide a call from the scan below.
      if (
        /\bgetConsumerBlobUploadUrl\s+as\s+\w+/.test(text) ||
        /\.getConsumerBlobUploadUrl\(/.test(text)
      )
        (sdk[path] ??= []).push('<aliased or member call>');
      if (SDK_IMPORT.test(text)) {
        const args = callArguments(text, 'getConsumerBlobUploadUrl', 'client');
        if (args.length) (sdk[path] ??= []).push(...args);
      }

      if (path !== definition && text.includes('getConsumerBlobUploadUrlService(')) {
        const args = callArguments(text, 'getConsumerBlobUploadUrlService', 'token');
        if (args.length) (service[path] ??= []).push(...args);
      }
    }
  }

  it('are minted only at the reviewed call sites', () => {
    expect(sdk).toEqual(SDK_CALLS);
  });

  it('reach the shared helper only from the reviewed callers', () => {
    expect(service).toEqual(SERVICE_CALLS);
  });

  it('take each parameter from the reviewed upstream source', () => {
    const missing = UPSTREAM.filter(
      ([file, source]) => !normalise(readFileSync(join(root, file), 'utf8')).includes(source)
    );
    expect(missing).toEqual([]);
  });

  it('are never minted with a client or token bound to the system credentials', () => {
    // Positive control: the scan reads a system binding through a variable, not only by name.
    const control = callArguments(
      'function f() { const client = internalOrchestratorClient; return getConsumerBlobUploadUrl({ client }); }',
      'getConsumerBlobUploadUrl',
      'client'
    );
    expect(control).toEqual(['client <- internalOrchestratorClient']);
    expect(control.some((entry) => SYSTEM_CREDENTIALS.test(entry))).toBe(true);

    const system = [...Object.entries(sdk), ...Object.entries(service)].filter(([, entries]) =>
      entries.some((entry) => SYSTEM_CREDENTIALS.test(entry))
    );
    expect(system).toEqual([]);
    expect(UPSTREAM.filter(([, source]) => SYSTEM_CREDENTIALS.test(source))).toEqual([]);
  });
});
