import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { importGraph, parseImports, REPO_ROOT } from './import-graph.harness';

/**
 * Server notification processors must not reach client UI packages. Most server code loads the
 * notification registry, so a client import here lands in every server test file that touches it.
 * Put shared constants in a leaf module under `~/shared/constants`.
 */
const NOTIFICATIONS_DIR = 'src/server/notifications';
const DENIED = [/^next\/router$/, /^@mantine\//];

const entries = fs
  .readdirSync(path.join(REPO_ROOT, NOTIFICATIONS_DIR))
  .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
  .map((f) => `${NOTIFICATIONS_DIR}/${f}`);

function deniedImports() {
  const graph = importGraph(entries, { followDynamic: false });
  const hits: string[] = [];
  for (const file of graph.keys()) {
    const source = fs.readFileSync(path.join(REPO_ROOT, file), 'utf8');
    for (const { spec, dynamic } of parseImports(source)) {
      if (!dynamic && DENIED.some((re) => re.test(spec))) hits.push(`${file} -> ${spec}`);
    }
  }
  return { graph, hits: hits.sort() };
}

describe('server notification graph', () => {
  const { graph, hits } = deniedImports();

  it('walks the notification processors', () => {
    // A walk that found nothing would pass the assertion below for free.
    expect(entries.length).toBeGreaterThan(10);
    expect(graph.has(`${NOTIFICATIONS_DIR}/auction.notifications.ts`)).toBe(true);
    expect(graph.size).toBeGreaterThan(entries.length);
  });

  it('imports no client router or Mantine module', () => {
    expect(hits).toEqual([]);
  });
});
