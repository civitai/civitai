import { env } from '~/env/server';
import { dbRead } from '~/server/db/client';
import { clavata, ClavataTag } from '~/server/integrations/clavata';
import { logToAxiom } from '~/server/logging/client';
import { withRetries } from '~/server/utils/errorHandling';
import { ChatMessageType } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { createJob, getJobDate } from './job';

const jobName = 'clavata-moderation';

const log = createLogger(jobName, 'blue');
const logAx = (data: MixedObject) => {
  logToAxiom({ name: jobName, type: 'error', ...data }, 'webhooks').catch();
};

const modChatJob = createJob(`${jobName}-chat`, '*/10 * * * *', modChat);

export const clavataModerationJobs = [modChatJob];

async function modChat() {
  const [lastRun, setLastRun] = await getJobDate(`${jobName}-chat`);
  log(`Starting ${jobName}-chat`);

  const policyId = env.CLAVATA_POLICIES?.chat;
  if (!policyId) {
    logAx({ message: 'No policy id found for "chat"' });
    return;
  }

  const data = await dbRead.chatMessage.findMany({
    select: {
      id: true,
      // createdAt: true,
      // userId: true,
      // chatId: true,
      content: true,
    },
    where: {
      createdAt: { gt: lastRun },
      userId: { not: -1 },
      contentType: ChatMessageType.Markdown,
    },
  });

  console.log(data.length);
  if (data.length > 0) {
    const results = await Promise.all(
      data.map((d) => {
        return withRetries(async () => {
          try {
            const resp = await clavata!.runTextJobAsync(d.content, policyId);
            return { ...resp, data: d };
          } catch (e) {
            const err = e as Error;
            logAx({
              message: 'Error running clavata moderation: Chat',
              data: {
                error: err.message,
                cause: err.cause,
                chatId: d.id,
                text: d.content,
              },
            });
            return { externalId: '', tags: [] as ReadonlyArray<ClavataTag>, data: d };
          }
        });
      })
    );

    console.log(results);

    const filteredResults = results.filter((r) => r.externalId.length > 0 && r.tags.length > 0);

    // only get certain outcome
    for (const result of filteredResults) {
    }
  }

  await setLastRun();
}
