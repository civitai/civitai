import type { AxiomAPIRequest } from '@civitai/next-axiom';
import { withAxiom } from '@civitai/next-axiom';
import type { NextApiResponse } from 'next';
import { getSessionFromBearerToken } from '~/server/auth/bearer-token';
import { isAppBlocksTaskKindEnabled } from '~/server/services/app-blocks-flag';
import { getTaskRouterConfig } from '~/server/services/blocks/task-router.service';
import type { McpCaller } from '~/server/services/task-router-mcp.service';
import { handleMcpMessage, isMcpCallerAllowed } from '~/server/services/task-router-mcp.service';
import { TokenScope } from '~/shared/constants/token-scope.constants';
import type { SessionUser } from '~/types/session';
import { Flags } from '~/shared/utils/flags';

/**
 * Task Router MCP server (experimental), streamable-HTTP transport, stateless: tools
 * `find_tasks` and `run_task`. Bearer only (a personal API key or an OAuth token with the
 * AI-services write scope), never a cookie, because `run_task` spends the caller's Buzz.
 */
export default withAxiom(async (req: AxiomAPIRequest, res: NextApiResponse) => {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const config = getTaskRouterConfig('mcp');
  if (!config) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  const authHeader = req.headers.authorization;
  const token = authHeader?.toLowerCase().startsWith('bearer ')
    ? authHeader.slice('bearer '.length).trim()
    : '';
  if (!token) {
    res.status(401).json({ error: 'Missing or malformed Bearer token' });
    return;
  }
  const session = await getSessionFromBearerToken(token);
  if (!session?.user) {
    res.status(401).json({ error: 'Invalid token' });
    return;
  }
  if (!Flags.hasFlag(session.tokenScope, TokenScope.AIServicesWrite)) {
    res.status(403).json({ error: 'This token lacks the AI services write scope' });
    return;
  }

  const caller: McpCaller = { userId: session.user.id, token, subject: session.subject };
  if (
    !isMcpCallerAllowed(config, caller) ||
    !(await isAppBlocksTaskKindEnabled({ user: session.user as SessionUser }))
  ) {
    res.status(403).json({ error: 'Tasks are not enabled for this account' });
    return;
  }

  const reply = await handleMcpMessage(config, caller, req.body);
  if (!reply) {
    res.status(202).end();
    return;
  }
  res.status(200).json(reply);
});
