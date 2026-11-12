import * as z from 'zod';
import { logToAxiom, safeError } from '~/server/logging/client';
import { getAppAssistantRefusal } from '~/server/services/app-assistant/app-assistant.service';
import { sourceSaveAnswer } from '~/server/services/app-assistant/source-save-route';
import { saveAssistantSourceFromSandbox } from '~/server/services/blocks/app-source-repo.service';
import { AuthedEndpoint } from '~/server/utils/endpoint-helpers';
import { requireFullScopeSession } from '~/server/utils/require-full-scope-session';

const bodySchema = z.object({ app: z.string().min(1).max(64) });

/**
 * POST { app } → commit the caller's App Assistant app `app`, as their sandbox holds it now, to the
 * app's source repo (the developer's git history, `civitai-apps-src/<slug>`), creating the repo on
 * the app's first save. App Assistant's page calls it after the assistant changed the app's files.
 * civitai reads the files from the sandbox itself, as the caller; nothing but the key is sent.
 *
 * Refused as App Assistant refuses the caller (ban, onboarding, mute, email, the flags), and 404 for
 * an app that is not theirs. Nothing it writes builds or files a publish request.
 */
export default AuthedEndpoint(
  async (req, res, user) => {
    if (!requireFullScopeSession(req, res)) return;
    const refusal = await getAppAssistantRefusal({ user, req });
    if (refusal) return res.status(refusal.status).json({ error: refusal.error });
    const body = bodySchema.safeParse(req.body);
    if (!body.success) return res.status(400).json({ error: 'app is required' });
    res.setHeader('Cache-Control', 'no-store');
    try {
      const answer = sourceSaveAnswer(
        await saveAssistantSourceFromSandbox({ userId: user.id, app: body.data.app })
      );
      return res.status(answer.status).json(answer.json);
    } catch (err) {
      logToAxiom({
        type: 'app-assistant.source-save.failed',
        message: `App Assistant source save failed for user ${user.id}`,
        userId: user.id,
        app: body.data.app,
        error: safeError(err),
      }).catch(() => undefined);
      return res.status(503).json({ error: 'Could not save the app right now' });
    }
  },
  ['POST']
);
