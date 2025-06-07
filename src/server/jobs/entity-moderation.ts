import { StreamError } from '@clavata/sdk';
import type { Prisma } from '@prisma/client';
import { Tracker } from '~/server/clickhouse/client';
import { dbRead, dbWrite } from '~/server/db/client';
import { clavataEvaluate } from '~/server/integrations/clavata';
import { logToAxiom } from '~/server/logging/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import type { EntityType } from '~/shared/utils/prisma/enums';
import {
  ChatMessageType,
  JobQueueType,
  ModerationRequest_ExternalType,
} from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { modURLBlocklist, modWordBlocklist } from '~/utils/metadata/audit';
import { createJob, getJobDate } from './job';

const jobName = 'entity-moderation';

const log = createLogger(jobName, 'blue');
const logAx = (data: MixedObject) => {
  log(data);
  logToAxiom({ name: jobName, type: 'error', ...data }, 'webhooks').catch();
};

const tracker = new Tracker();

// TODO pull wordlists out of code, put into somewhere else like redis
// console.log({ modURLBlocklist, modWordBlocklist });

function hasIssue(text: string | null) {
  // ahocorasick, but it's not good

  if (!text || text.trim().length === 0) return false;
  const lower = text.trim().toLowerCase();

  // can return w.word if we want all of them
  const hasBadWord = modWordBlocklist.some((w) => w.re.test(lower));
  if (hasBadWord) return true;
  const hasBadUrl = modURLBlocklist.some((w) => w.re.test(lower));
  if (hasBadUrl) return true;

  return false;
}

// type PrismaSelectForModel<T extends Uncapitalize<Prisma.ModelName>> =
//   T extends Uncapitalize<Prisma.ModelName>
//     ? Prisma.Args<(typeof dbRead)[T], 'findMany'>['select']
//     : never;

type EntityQueueConfig<T extends Uncapitalize<Prisma.ModelName> = Uncapitalize<Prisma.ModelName>> =
  {
    // fields: Prisma.Args<(typeof dbRead)[T], 'findMany'>['select'];
    // fields: Partial<PrismaSelectForModel<T>>;
    fields: Record<string, true>;
    selector: (typeof dbRead)[T];
    idKey?: string;
    userIdKey?: string;
  };

type QueuesConfig = {
  [K in EntityType]?: EntityQueueConfig;
};

const queues: QueuesConfig = {
  // const queues = {
  Comment: {
    fields: { content: true },
    selector: dbRead.comment,
  },
  CommentV2: {
    fields: { content: true },
    selector: dbRead.commentV2,
  },
  User: {
    fields: { username: true },
    selector: dbRead.user,
    userIdKey: 'id',
  },
  UserProfile: {
    fields: { bio: true, message: true },
    selector: dbRead.userProfile,
    idKey: 'userId',
  },
  Model: {
    fields: { name: true, description: true },
    selector: dbRead.model,
  },
  Post: {
    fields: { title: true, detail: true },
    selector: dbRead.post,
  },
  ResourceReview: {
    fields: { details: true },
    selector: dbRead.resourceReview,
  },
  Article: {
    fields: { title: true, content: true },
    selector: dbRead.article,
  },
  Bounty: {
    fields: { name: true, description: true },
    selector: dbRead.bounty,
  },
  BountyEntry: {
    fields: { description: true },
    selector: dbRead.bountyEntry,
  },
  Collection: {
    fields: { name: true, description: true },
    selector: dbRead.collection,
  },
} as const;
const special = {
  ChatMessage: {
    fields: { content: true },
    selector: dbRead.chatMessage,
  },
};
type QueueValues = { [K in keyof typeof queues | keyof typeof special]?: string };

async function getPolicies() {
  const policies = await sysRedis.get(REDIS_SYS_KEYS.MODERATION.CLAVATA);
  return policies ? (JSON.parse(policies) as QueueValues) : ({} as QueueValues);
}

const deleteFromJobQueue = async (entityType: EntityType, ids: number[]) => {
  try {
    await dbWrite.jobQueue.deleteMany({
      where: {
        type: JobQueueType.ModerationRequest,
        entityType,
        entityId: { in: ids },
      },
    });
  } catch (error) {
    logAx({ message: 'Error deleting job queue', data: { error, entityType, ids } });
  }
};

interface ContentItem {
  id: number;
  userId: number;
  value: string;
}

type MetadataType = {
  id: string;
  type: keyof QueueValues;
  userId: string;
};

const runClavata = async ({
  policyId,
  type,
  data,
  deleteJob = true,
}: {
  policyId: string;
  type: keyof QueueValues;
  data: ContentItem[];
  deleteJob?: boolean;
}) => {
  log(`Clavata processing ${data.length} ${type}s`);

  try {
    const stream = clavataEvaluate({
      policyId,
      contentData: data.map(({ id, value, userId }) => {
        const metadata: MetadataType = { id: id.toString(), type, userId: userId.toString() };
        return {
          metadata,
          content: { value, $case: 'text' },
          contentType: 'text',
        };
      }),
    });

    for await (const item of stream) {
      console.log(item);

      if (item.result === 'FALSE') {
        continue;
      }

      const _metadata = item.metadata as MetadataType | undefined;
      if (!_metadata || !_metadata.id) {
        logAx({ message: 'No id found', data: { item } });
        continue;
      }

      const metadata = {
        ..._metadata,
        id: Number(_metadata.id),
        userId: Number(_metadata.userId),
      };

      const { id: metadataId, type: metadataType, ...restMetadata } = metadata;

      // TODO try catch doesnt work here?
      try {
        await dbWrite.moderationRequest.create({
          data: {
            externalId: item.externalId,
            externalType: ModerationRequest_ExternalType.Clavata,
            entityType: type,
            entityId: metadata.id,
            tags: item.tags,
            metadata: restMetadata,
          },
        });
      } catch (error) {
        logAx({
          message: 'Error creating moderation request',
          data: { error, type, id: metadata.id },
        });
        continue;
      }

      try {
        await tracker.moderationRequest({
          entityType: type,
          entityId: metadata.id,
          userId: metadata.userId,
          rules: item.tags?.map((t) => t.tag) ?? [],
          date: new Date(),
          // valid: item.result === '', // TODO
        });
      } catch (error) {
        logAx({
          message: 'Error tracking moderation request',
          data: { error, type, id: metadata.id },
        });
        continue;
      }

      if (deleteJob) {
        // TODO batching these would probably be better but this is fine for now
        await deleteFromJobQueue(type, [metadata.id]);
      }
    }
  } catch (error) {
    if (error instanceof StreamError) {
      // should we be returning data like the ID instead?
      logAx({
        message: 'Error running clavata moderation',
        data: {
          error: error.message,
          name: error.name,
          cause: error.cause,
          stack: error.stack,
          code: error.code,
        },
      });
    } else if (error instanceof Error) {
      logAx({ message: 'Error with clavata SDK', data: { error: error.message } });
    } else {
      logAx({ message: 'Error with clavata SDK', data: { error } });
    }
  }
};

//

async function modChat() {
  const [lastRun, setLastRun] = await getJobDate(`${jobName}-chatMessage`);
  log(`Starting ${jobName}-chatMessage`);

  const policies = await getPolicies();
  const policyId = policies.ChatMessage;
  if (!policyId) {
    logAx({ message: 'No policy id found for "chatMessage"' });
    return;
  }

  // special case, not using JobQueue

  try {
    const data = await dbRead.chatMessage.findMany({
      select: {
        id: true,
        userId: true,
        chatId: true,
        content: true,
      },
      where: {
        createdAt: { gt: lastRun },
        userId: { not: -1 },
        contentType: ChatMessageType.Markdown,
      },
      orderBy: {
        createdAt: 'asc',
      },
    });
    // .catch((error) => {
    //   logAx({ message: 'Error getting chat messages', data: { error } });
    //   return [];
    // });

    console.log(data);

    const badMessages = data.filter((d) => hasIssue(d.content));

    if (badMessages.length > 0) {
      const badMessagesByChat = badMessages.reduce((acc, cur) => {
        const key = `${cur.chatId}`;
        if (!acc[key]) acc[key] = '';
        acc[key] += `${cur.userId}: ${cur.content}\n`;
        return acc;
      }, {} as Record<string, string>);

      // note: id is actually chatId
      await runClavata({
        policyId,
        type: 'ChatMessage',
        data: Object.entries(badMessagesByChat).map(([key, value]) => ({
          id: Number(key),
          userId: -1, // TODO how to get actual userId?
          value,
        })),
        deleteJob: false,
      });
    }

    log(`Finished ${jobName}-chatMessage, processed ${data.length} items`);
    await setLastRun();
  } catch (error) {
    logAx({ message: 'Error handling chatMessage', data: { error } });
  }
}

async function modQueue() {
  const [lastRun, setLastRun] = await getJobDate(`${jobName}-queues`);
  log(`Starting ${jobName}-queues`);

  const policies = await getPolicies();

  const policyMap: { -readonly [key in keyof typeof queues]?: string } = {};
  for (const key of Object.keys(queues) as (keyof typeof queues)[]) {
    const policy = policies[key];
    if (policy) {
      policyMap[key] = policy;
    } else {
      logAx({ message: `No policy id found for "${key}"` });
    }
  }

  if (Object.keys(policyMap).length === 0) {
    logAx({ message: 'No policies found' });
    return;
  }

  const validQueues = Object.keys(policyMap) as EntityType[];

  // TODO do we want to refetch everything? add a status col to jobqueue? add metadata field?
  //  batch / paginate here?
  const queueRows = await dbRead.jobQueue.findMany({
    select: {
      entityType: true,
      entityId: true,
    },
    where: {
      type: JobQueueType.ModerationRequest,
      entityType: { in: validQueues },
      // createdAt: { gt: lastRun }, // TODO maybe not?
    },
    orderBy: {
      createdAt: 'asc',
    },
  });

  type EntityIdMap = { [key in EntityType]?: number[] };

  const aggedRows: EntityIdMap = queueRows.reduce((prev, curr) => {
    const table = curr.entityType;
    if (!prev[table]) prev[table] = [];
    prev[table].push(curr.entityId);
    return prev;
  }, {} as EntityIdMap);

  async function processEntityType<T extends keyof typeof queues>(entityType: T) {
    log(`Starting ${jobName}-${entityType}`);
    const ids = aggedRows[entityType];

    if (!ids?.length) {
      log(`Finished ${jobName}-${entityType}, no items`);
      return;
    }

    try {
      const { fields, selector, idKey = 'id', userIdKey = 'userId' } = queues[entityType]!;

      if (!selector || typeof selector.findMany !== 'function') {
        logAx({ message: `No model found for entity type: ${entityType}` });
        return;
      }

      const data: ({ [entityIdKey: string]: number } & { [key in keyof typeof fields]: string })[] =
        await (selector as any).findMany({
          where: { [idKey]: { in: ids } },
          select: { [idKey]: true, [userIdKey]: true, ...fields },
        });

      for (const col of Object.keys(fields) as (keyof typeof fields)[]) {
        const { goodData, badData } = data.reduce(
          (acc, d) => {
            if (hasIssue(d[col])) {
              acc.badData.push(d);
            } else {
              acc.goodData.push(d);
            }
            return acc;
          },
          { goodData: [], badData: [] } as { goodData: typeof data; badData: typeof data }
        );

        if (goodData.length > 0) {
          await deleteFromJobQueue(
            entityType,
            goodData.map((d) => d[idKey] as unknown as number)
          );
        }

        if (badData.length > 0) {
          await runClavata({
            policyId: policyMap[entityType]!,
            type: entityType,
            data: badData.map((d) => ({
              id: d[idKey] as unknown as number,
              userId: d[userIdKey] as unknown as number,
              value: d[col]!,
            })),
          });
        }
      }

      log(`Finished ${jobName}-${entityType}, processed ${data.length} items`);
    } catch (error) {
      logAx({ message: `Error handling ${entityType}`, data: { error } });
    }
  }

  for (const entityType of validQueues) {
    await processEntityType(entityType);
  }

  log(`Finished ${jobName}-queues`);
  await setLastRun();
}

//

const modChatJob = createJob(`${jobName}-chat`, '*/5 * * * *', modChat);
const modQueueJob = createJob(`${jobName}-queues`, '*/5 * * * *', modQueue);

export const entityModerationJobs = [modChatJob, modQueueJob];
