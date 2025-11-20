import { TimeSpan, WorkflowStep } from '@civitai/client';
import type { NextApiRequest, NextApiResponse } from 'next';
import { env } from '~/env/server';
import { getTemporaryUserApiKey } from '~/server/services/api-key.service';
import { queryWorkflows } from '~/server/services/orchestrator/workflows';
import { getEncryptedCookie, setEncryptedCookie } from '~/server/utils/cookie-encryption';
import { WebhookEndpoint } from '~/server/utils/endpoint-helpers';
import { getServerAuthSession } from '~/server/auth/get-server-auth-session';
import { generationServiceCookie } from '~/shared/constants/generation.constants';

export default WebhookEndpoint(async function (req: NextApiRequest, res: NextApiResponse) {
  const session = await getServerAuthSession({ req, res });
  const user = session?.user;
  if (!user) return;

  let token = getEncryptedCookie({ req, res }, generationServiceCookie.name);
  if (env.ORCHESTRATOR_MODE === 'dev') token = env.ORCHESTRATOR_ACCESS_TOKEN;
  if (!token) {
    token = await getTemporaryUserApiKey({
      name: generationServiceCookie.name,
      // make the db token live just slightly longer than the cookie token
      maxAge: generationServiceCookie.maxAge + 5,
      scope: ['Generate'],
      type: 'System',
      userId: user.id,
    });
    setEncryptedCookie(
      { req, res },
      {
        name: generationServiceCookie.name,
        maxAge: generationServiceCookie.maxAge,
        value: token,
      }
    );
  }

  const { nextCursor, items } = await queryWorkflows({
    token,
    take: 1000,
    tags: ['gen'],
    hideMatureContent: false,
  });

  const dictionary: Record<string, any> = {};
  function addToDictionary(type: string, data: any) {
    if (!dictionary[type]) dictionary[type] = [];
    dictionary[type].push(data);
  }
  for (const item of items) {
    for (const step of item.steps ?? []) {
      if (step.startedAt && step.completedAt) {
        const started = new Date(step.startedAt).getTime();
        const completed = new Date(step.completedAt).getTime();
        const seconds = Math.ceil((completed - started) / 1000);
        const minutes = Math.floor(seconds / 60);
        const offset = `${((seconds % 60) / 100).toFixed(2)}`.replace('0.', '');
        const time = `${minutes}:${offset}`;
        switch (step.$type) {
          case 'videoGen': {
            const parsed = handleVideoGenStep(step);
            if (parsed && seconds > 0)
              addToDictionary((step as any).input.engine, {
                ...parsed,
                seconds,
                time,
              });
            break;
          }
        }
      }
    }
  }

  return res.status(200).json(dictionary);
});

function handleVideoGenStep(step: any) {
  const input = step.input;
  switch (input.engine) {
    case 'hunyuan':
    case 'wan':
      return {
        width: input.width,
        height: input.height,
        duration: input.duration,
        steps: input.steps,
        frameRate: input.frameRate,
        type: input.sourceImage ? 'img2vid' : 'txt2vid',
      };
    default:
      return null;
  }
}
