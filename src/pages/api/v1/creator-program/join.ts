import type { NextApiRequest, NextApiResponse } from 'next';
import { joinCreatorsProgram } from '~/server/services/creator-program.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import type { SessionUser } from '~/types/session';

// Join the Creator Program from a spoke (the Creator Studio /join page) — the same eligibility checks as the
// onsite tRPC procedure run inside joinCreatorsProgram (valid membership + creator score + not banned). The
// spoke calls this server-to-server, forwarding the shared .civitai.com session cookie that AuthedEndpoint
// validates. joinCreatorsProgram refreshes the session, so the spoke's next load sees the new membership.
export default AuthedEndpoint(
  async function handler(_req: NextApiRequest, res: NextApiResponse, user: SessionUser) {
    try {
      await joinCreatorsProgram(user.id);
      return res.status(200).json({ success: true });
    } catch (error) {
      const err = error as { code?: string; message?: string };
      const status = err?.code === 'BAD_REQUEST' ? 400 : 500;
      return res.status(status).json({ error: err?.message ?? 'Failed to join the Creator Program.' });
    }
  },
  ['POST']
);
