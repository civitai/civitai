import { env } from '~/env/server.mjs';
import { dbWrite } from '~/server/db/client';
import { createTrainingRequest } from '~/server/services/training.service';
import { createJob } from './job';
import {
  OrchestratorEventSchema,
  handleOrchestratorEvent,
} from '~/pages/api/webhooks/image-resource-training';

export const resubmitTrainingJobs = createJob(
  'resubmit-training-jobs',
  '20,50 * * * *',
  async () => {
    // Get the training jobs that are potentially stuck
    // --------------------------------------------
    const failedTrainingJobs = await dbWrite.$queryRaw<
      { id: number; metadata: FileMetadata | null; userId: number }[]
    >`
        SELECT mv.id,
               mf.metadata,
               m."userId"
        FROM "ModelVersion" mv
                 JOIN "Model" m ON m.id = mv."modelId"
                 JOIN "ModelFile" mf ON mf."modelVersionId" = mv.id AND mf.type = 'Training Data'
        WHERE mv."trainingStatus" in ('Processing', 'Submitted')
          AND m.status != 'Deleted';
    `;

    // Resubmit the training jobs
    // --------------------------------------------
    for (const { id, metadata, userId } of failedTrainingJobs) {
      const jobHistory = metadata?.trainingResults?.history?.slice(-1);
      if (jobHistory && jobHistory.length) {
        const jobToken = jobHistory[0].jobToken;
        const jobId = jobHistory[0].jobId;
        const response = await fetch(`${env.GENERATION_ENDPOINT}/v1/consumer/jobs/${jobToken}`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
          },
        });

        if (response.status !== 404) {
          continue;
        }

        const restored = await attemptRestoreFromEvent(jobId);
        if (restored) {
          console.log(`successfully restored job ${jobId} from event`);
          continue;
        }

        await createTrainingRequest({ modelVersionId: id, userId });
      }
    }
  }
);

async function attemptRestoreFromEvent(jobId: string) {
  const eventsResponse = await fetch(
    `${env.GENERATION_ENDPOINT}/v1/producer/jobs/${jobId}/events?descending=true&take=1`,
    {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${env.ORCHESTRATOR_TOKEN}`,
      },
    }
  );

  if (eventsResponse.status !== 200) {
    console.log('Failed to get events for job', jobId);
    console.log('Response:', eventsResponse.status, await eventsResponse.text());
    return false;
  }

  const events = await eventsResponse.json();
  console.log('events', JSON.stringify(events));
  if (!(events instanceof Array && events.length)) {
    console.log('No events found for job', jobId);
    return false;
  }

  const lastEvent = events[0];
  if (lastEvent.type !== 'Success') {
    console.log('Last event was not a success', lastEvent);
    return false;
  }

  const bodyResults = OrchestratorEventSchema.safeParse(lastEvent);
  if (!bodyResults.success) {
    console.log('Failed to parse event', bodyResults.error);
    return false;
  }

  try {
    await handleOrchestratorEvent(bodyResults.data);
  } catch (err) {
    console.log('Failed to handle event', err);
    return false;
  }

  return true;
}
