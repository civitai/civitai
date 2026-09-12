import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { clientSchema } from '~/env/client-schema';

/**
 * The embedded Training Studio must hand the BROWSER a public orchestrator origin.
 *
 * The web component calls the orchestrator directly from the browser
 * (`docs/training-studio-web-component.md`), so its `config.orchestratorEndpoint` is consumed by
 * client code. `ORCHESTRATOR_ENDPOINT` is the server's IN-CLUSTER address
 * (`http://orchestration-api.orchestration-poc.svc.cluster.local:8080`). Passing it to the element
 * produced, on every mount of /training-studio:
 *
 *     Mixed Content: … requested an insecure resource 'http://orchestration-api.…:8080/v2/…'
 *     GET http://orchestration-api.…svc.cluster.local:8080/v2/consumer/workflows
 *         net::ERR_NAME_NOT_RESOLVED
 *
 * Two independent guards below, because the two halves fail differently: the schema half catches a
 * public default that is secretly an internal address, and the source half catches the server-only
 * key creeping back into a browser-facing module. Neither subsumes the other.
 *
 * 🔴 What this does NOT cover: it cannot prove the element actually reaches the orchestrator, only
 * that no in-cluster value is wired to it. The reachability claim is a live probe (preflight +
 * a 401 on /v2/consumer/workflows from the page's origin), not a unit test.
 */

const SERVER_KEY = 'ORCHESTRATOR_ENDPOINT';
const PUBLIC_KEY = `NEXT_PUBLIC_${SERVER_KEY}`;

/** Modules whose contents are consumed by, or sent to, a browser. */
const BROWSER_FACING = [
  // Builds the element's host config.
  'pages/training-studio/index.tsx',
  // Its JSON response goes straight to the page.
  'pages/api/training-studio/host.ts',
];

/**
 * Strip comments so a reference *explaining* the hazard does not read as the hazard. Both files
 * deliberately name `ORCHESTRATOR_ENDPOINT` in prose to warn against re-adding it; a raw substring
 * scan would flag exactly the comments that exist to prevent the bug. Controls below prove the
 * stripper distinguishes the two cases — without them this guard could be passing because it sees
 * nothing at all.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Server-key references in CODE, with the public key's occurrences removed first — `PUBLIC_KEY`
 *  contains `SERVER_KEY` as a substring, so searching naively would match every correct use. */
function serverKeyRefsInCode(source: string): number {
  const code = stripComments(source).split(PUBLIC_KEY).join('');
  return code.split(SERVER_KEY).length - 1;
}

describe('training-studio embed: browser gets the public orchestrator origin', () => {
  it('the instrument works: it sees a code reference and ignores a comment', () => {
    // Positive control — a reassuring zero is worthless until the scanner has been shown to count.
    expect(serverKeyRefsInCode(`const a = env.${SERVER_KEY};`)).toBe(1);
    expect(serverKeyRefsInCode(`/* do not use ${SERVER_KEY} */`)).toBe(0);
    expect(serverKeyRefsInCode(`// never pass ${SERVER_KEY} to the browser`)).toBe(0);
    // The public key must not register as the server key despite containing it.
    expect(serverKeyRefsInCode(`const a = env.${PUBLIC_KEY};`)).toBe(0);
    // A URL containing `//` must not swallow the rest of the line as a comment.
    expect(serverKeyRefsInCode(`const a = 'http://x'; const b = env.${SERVER_KEY};`)).toBe(1);
  });

  it.each(BROWSER_FACING)('%s does not read the server-only endpoint', (relative: string) => {
    const full = path.resolve(__dirname, '../..', relative);
    expect(fs.existsSync(full), `${relative} should exist`).toBe(true);
    expect(serverKeyRefsInCode(fs.readFileSync(full, 'utf8'))).toBe(0);
  });

  it('the public endpoint default is a reachable public origin, not an internal address', () => {
    // Read the default through the real schema rather than re-stating the literal.
    const value = clientSchema.shape[PUBLIC_KEY].parse(undefined);

    expect(value.startsWith('https://')).toBe(true);
    expect(value).not.toContain('.svc.cluster.local');
    expect(value).not.toContain('.local');
    expect(value).not.toContain('localhost');
    // An explicit port is the tell of an in-cluster service address; a public origin needs none.
    expect(value.replace('https://', '')).not.toContain(':');
  });
});
