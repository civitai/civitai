import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

// Every place that mints a consumer blob upload URL, and the client or token it mints with.
// A consumer upload carries the user's own media, so it is minted with that user's orchestrator
// token: the upload is then attributed to and processed for the user. The shared system client
// mints a presign that carries no user.
// Adding, removing or changing an entry is a review decision, not a test fix.
const SDK_CALLS: Record<string, string[]> = {
  // A client the caller builds from the signed-in user's token (the embed's host token, or the
  // app's own session token).
  'apps/training-studio/src/lib/orchestrator-core.ts': ['client'],
  // createOrchestratorClient(token), with the token its caller passes in (below).
  'src/server/services/orchestrator/consumerBlobUpload.ts': ['client'],
};

// Callers of getConsumerBlobUploadUrlService, and the token argument each passes.
const SERVICE_CALLS: Record<string, string[]> = {
  // OrchestratorEndpoint hands the handler the caller's own token.
  'src/pages/api/orchestrator/getConsumerBlobUploadUrl.ts': ['token'],
  // The training wizard's auto-label upload: getOrchestratorToken(userId, ctx).
  'src/server/services/training.service.ts': ['token'],
};

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

/** The `client` (or `token`) argument of each call, or a marker for a call shape not read here. */
function callArguments(text: string, callee: string, key: string): string[] {
  const calls = [...text.matchAll(new RegExp(`\\b${callee}\\(`, 'g'))];
  return calls.map((call) => {
    const rest = text.slice((call.index ?? 0) + call[0].length);
    const m = rest.match(new RegExp(`^\\s*\\{\\s*${key}\\s*(?::\\s*([\\w.$]+))?\\s*[,}]`));
    return m ? m[1] ?? key : '<unread call shape>';
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

  it('are never minted with the system client or token', () => {
    const system = [...Object.entries(sdk), ...Object.entries(service)].filter(([, args]) =>
      args.some((arg) => SYSTEM_CREDENTIALS.test(arg))
    );
    expect(system).toEqual([]);
  });
});
