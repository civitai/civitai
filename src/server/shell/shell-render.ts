import type { IncomingMessage } from 'http';
import { resolveShellSeeds } from '~/server/services/settings-bootstrap.service';
import { getFeatureFlagsAsync } from '~/server/services/feature-flags.service';
import type { ShellRouteName } from '~/server/shell/shell-mode';
import { resolveShellMode } from '~/server/shell/shell-mode';

export type ShellRender = {
  route: ShellRouteName;
  flags: Awaited<ReturnType<typeof getFeatureFlagsAsync>>;
  seeds: Awaited<ReturnType<typeof resolveShellSeeds>>;
};

/**
 * What `_app.getInitialProps` renders a static shell from, or `null` for a full render. Every value
 * is the same for every viewer of the host: the flags are evaluated with no user and no request
 * (so no region), and the seeds are the bootstrap's viewer-independent members.
 *
 * 🔴 SERVER ONLY (it reaches the database and redis through the seeds). `_app` imports it inside
 * its `typeof window === 'undefined'` block; `no-server-infra-in-app-graph.test.ts` pins that edge.
 */
export async function resolveShellRender(
  req: IncomingMessage,
  pathname: string
): Promise<ShellRender | null> {
  const route = await resolveShellMode(req, pathname);
  if (!route) return null;
  const [flags, seeds] = await Promise.all([
    getFeatureFlagsAsync({ host: req.headers.host, req }), // MUTATION M9
    resolveShellSeeds(req),
  ]);
  return { route, flags, seeds };
}
