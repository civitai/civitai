import { StreamError } from '@clavata/sdk';
import type { Prisma } from '@prisma/client';
import dayjs from '~/shared/utils/dayjs';
import { chunk } from 'lodash-es';
import { Tracker } from '~/server/clickhouse/client';
import { ExternalModerationType } from '~/server/common/enums';
import { dbRead, dbWrite } from '~/server/db/client';
import { clavataEvaluate } from '~/server/integrations/clavata';
import { logToAxiom } from '~/server/logging/client';
import { clavataCounter } from '~/server/prom/client';
import { REDIS_SYS_KEYS, sysRedis } from '~/server/redis/client';
import { ReportEntity } from '~/shared/utils/report-helpers';
import { createReport } from '~/server/services/report.service';
import { hashContent } from '~/server/services/entity-moderation.service';
import { autoMuteScamAccount } from '~/server/services/scam-auto-mute.service';
import { getTextScanOwnedClavataKeys } from '~/server/services/text-scan/clavata-cutover';
import { clavataVerdict, logScanVerdict } from '~/server/services/text-scan/verdict-log';
import type { ScamCleanup } from '~/server/services/scam-cleanup.service';
import { getBlocklists, type ModWordBlocklist } from '~/server/utils/moderation-utils';
import type { EntityType } from '~/shared/utils/prisma/enums';
import { ChatMessageType, JobQueueType, ReportReason } from '~/shared/utils/prisma/enums';
import { createLogger } from '~/utils/logging';
import { AUTOMATED_REPORT_RETENTION_DAYS, clearAutomatedReports } from './clear-automated-reports';
import { createJob, getJobDate } from './job';

// http://localhost:3000/api/webhooks/run-jobs?token=X&run=entity-moderation-queues
// http://localhost:3000/api/webhooks/run-jobs?token=X&run=entity-moderation-chat
// migrations: prisma\migrations\20250521094141_add_clavata_moderation\migration.sql

const jobName = 'entity-moderation';
const jobNameQueues = 'queues';
const jobNameChat = 'chat';
const jobNameClear = 'clear-automated';

const chunkSize = 100; // keep an eye on this
const minDate = '2025-06-13';

const autoMuteTags = ['Impersonating Civitai Staff'];

const log = createLogger(jobName, 'blue');
const logAx = (data: MixedObject) => {
  log(data);
  logToAxiom({ name: jobName, type: 'error', ...data }, 'webhooks').catch();
};

const tracker = new Tracker();

const autoMuteCleanup: Partial<Record<AllModKeys, ScamCleanup>> = {
  Chat: 'chatMessages',
  Comment: 'comments',
  CommentV2: 'commentsV2',
};

/** The newest flagged message a sender wrote in one flagged chat group. */
type ChatSender = { messageId: number; at: Date };

export function clavataScamEvidence({
  type,
  entityId,
  matches,
  value,
  sender,
}: {
  type: AllModKeys;
  entityId: number;
  matches: string[];
  value: string;
  sender?: ChatSender;
}) {
  const tags = [...matches].sort().join('|');
  const textHash = hashContent(value);
  // A chat group is keyed by the chat, so the sender's newest flagged message is what makes a later
  // offence in the same chat a new verdict. Other entities are keyed by their text, so an edit is too.
  const contentKey = sender ? `m${sender.messageId}` : textHash.slice(0, 16);
  return {
    source: `clavata:${type}`,
    dedupeKey: `clavata:${type}:${entityId}:${contentKey}:${tags}`,
    reason: `tags: ${matches.join(', ')}`,
    entityType: type,
    entityId,
    textHash,
    contentAt: sender?.at ?? null,
  };
}

export async function autoMuteIfScamAccount({
  type,
  entityId,
  userId,
  matches,
  value,
  sender,
}: {
  type: AllModKeys;
  entityId: number;
  userId: number;
  matches: string[];
  value: string;
  sender?: ChatSender;
}) {
  const cleanup = autoMuteCleanup[type];
  if (!cleanup) return;
  if (!matches.some((m) => autoMuteTags.includes(m))) return;

  try {
    const result = await autoMuteScamAccount({
      userId,
      cleanup,
      evidence: clavataScamEvidence({ type, entityId, matches, value, sender }),
    });
    log(`Auto-mute userId=${userId} type=${type}: ${JSON.stringify(result)}`);
  } catch (error) {
    logAx({ message: 'Error auto-muting user', data: { error, userId, type, entityId } });
  }
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

/*
Adding a new entry:
  - create a trigger or otherwise populate JobQueue
  - add the type to EntityType enum (if missing)
  - add the fields below
  - update relevant columns in gen_seed
  - optionally update policy in redis config
*/

// TODO possibly add modelVersion

const queues = {
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
} as const satisfies QueuesConfig;
const special = {
  Chat: {
    fields: { content: true },
    selector: dbRead.chatMessage,
  },
} as const;

type QueueKeys = keyof typeof queues;
export type AllModKeys = QueueKeys | keyof typeof special;
type RedisPolicyType = {
  [K in AllModKeys | 'default']?: string;
};
type RedisDisabledType = {
  [K in AllModKeys]?: boolean;
};

function hasIssue(
  text: string | null,
  modWordBlocklist: ModWordBlocklist,
  modURLBlocklist: ModWordBlocklist,
  useBlocklist: boolean,
  type: AllModKeys
) {
  if (!text || text.trim().length === 0) return false;

  // special handling for repetitive Collection data
  if (type === 'Collection') {
    // name
    if (['Bookmarked Articles', 'Liked Models', 'Bookmarked Model'].includes(text)) return false;
    // description
    if (
      [
        'Your bookmarked articles will appear in this collection.',
        'Your liked models will appear in this collection.',
        'Your bookmarked model will appear in this collection.',
      ].includes(text)
    )
      return false;
  }

  if (!useBlocklist) return true; // scan everything

  const lower = text.trim().toLowerCase();

  // can return w.word if we want all of them
  const hasBadWord = modWordBlocklist.some((w) => w.re.test(lower));
  if (hasBadWord) return true;
  const hasBadUrl = modURLBlocklist.some((w) => w.re.test(lower));
  // noinspection RedundantIfStatementJS
  if (hasBadUrl) return true;

  return false;
}

async function getPolicies() {
  const policies = await sysRedis.hGet(
    REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
    REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.CLAVATA_POLICIES
  );
  return policies ? (JSON.parse(policies) as RedisPolicyType) : ({} as RedisPolicyType);
}

export async function getDisabledEntities() {
  const [policies, owned] = await Promise.all([
    sysRedis.hGet(
      REDIS_SYS_KEYS.ENTITY_MODERATION.BASE,
      REDIS_SYS_KEYS.ENTITY_MODERATION.KEYS.ENTITIES
    ),
    getTextScanOwnedClavataKeys(),
  ]);
  const disabled = policies
    ? (JSON.parse(policies) as RedisDisabledType)
    : ({} as RedisDisabledType);
  for (const key of owned) disabled[key as AllModKeys] = false;
  return disabled;
}

function getPolicyFor(entity: AllModKeys, policies: RedisPolicyType) {
  return policies[entity] || policies.default;
}

const deleteFromJobQueue = async (entityType: QueueKeys, ids: number[]) => {
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
  userIds?: number[]; // For chat: all real userIds in a grouped entity
  senders?: Record<number, ChatSender>;
  value: string;
}

type MetadataType = {
  id: string;
  type: AllModKeys;
  userId: string;
  value: string;
};

const runClavata = async ({
  policyId,
  type,
  data,
  deleteJob = true,
}: {
  policyId: string;
  type: AllModKeys;
  data: ContentItem[];
  deleteJob?: boolean;
}) => {
  log(`Clavata processing ${data.length} ${type}s`);

  const batches = chunk(data, chunkSize);
  let i = 0;
  for (const batch of batches) {
    i++;
    log(`Clavata processing batch ${i}/${batches.length} for ${type}s`);
    clavataCounter?.inc(batch.length);
    try {
      const stream = clavataEvaluate({
        policyId,
        contentData: batch.map(({ id, value, userId }) => {
          const metadata: MetadataType = {
            id: id.toString(),
            type,
            userId: userId.toString(),
            value,
          };
          return {
            metadata,
            content: { value, $case: 'text' },
            contentType: 'text',
          };
        }),
      });

      for await (const item of stream) {
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

        const onlyNSFW = item.matches?.length === 1 && item.matches[0] === 'NSFW';
        const allowedNSFWTypes: AllModKeys[] = ['Bounty', 'Model'];

        const skipped = item.result === 'FALSE' || (onlyNSFW && !allowedNSFWTypes.includes(type));
        // Clean results too: they are the only record that Clavata passed this text.
        void logScanVerdict(
          clavataVerdict({
            entityType: type,
            entityId: metadata.id,
            userId: metadata.userId,
            result: item.result,
            matches: item.matches,
            skipped,
          })
        );

        if (skipped) {
          if (deleteJob) await deleteFromJobQueue(type as QueueKeys, [metadata.id]);
          continue;
        }

        // TODO try catch doesnt work here?
        try {
          const report = await createReport({
            type: ReportEntity[type === 'UserProfile' ? 'User' : type],
            id: metadata.id,
            userId: -1,
            isModerator: true,
            reason: ReportReason.Automated,
            details: {
              externalId: item.externalId,
              externalType: ExternalModerationType.Clavata,
              entityId: metadata.id,
              // tags: item.tags ?? [],
              tags: item.matches ?? [],
              userId: metadata.userId,
              // value: metadata.value, // value is too heavy to store here
            },
          });

          if (!report) {
            logAx({ message: 'Error creating report', data: { type, id: metadata.id } });
            continue;
          }

          await dbWrite.reportAutomated.create({
            data: {
              reportId: report.id,
              metadata: {
                tags: item.tags ?? [],
                value: metadata.value,
              },
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
            rules: item.matches ?? [],
            // value: metadata.value,
            date: new Date(),
          });
        } catch (error) {
          logAx({
            message: 'Error tracking moderation request',
            data: { error, type, id: metadata.id },
          });
          // continue; // we have enough logging, can proceed
        }

        // Auto-mute new accounts flagged for scam impersonation
        const matches = item.matches ?? [];
        const originalItem = batch.find((b) => b.id === Number(metadata.id));
        const userIdsToCheck = [
          ...new Set(
            originalItem?.userIds ?? (Number(metadata.userId) > 0 ? [Number(metadata.userId)] : [])
          ),
        ];

        log(
          `Auto-mute resolve: type=${type}, entityId=${metadata.id},` +
            ` userIds=[${userIdsToCheck.join(', ')}],` +
            ` source=${originalItem?.userIds ? 'chat-group' : 'metadata'}`
        );

        for (const uid of userIdsToCheck) {
          await autoMuteIfScamAccount({
            type,
            entityId: Number(metadata.id),
            userId: uid,
            matches,
            value: originalItem?.value ?? metadata.value ?? '',
            sender: originalItem?.senders?.[uid],
          });
        }

        if (deleteJob) {
          // TODO batching these would probably be better but this is fine for now
          await deleteFromJobQueue(type as QueueKeys, [metadata.id]);
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
      } else {
        logAx({ message: 'Error with clavata SDK', data: { error } });
      }
    }
  }
};

//

async function runModChat(lastRun: Date) {
  const disallowed = await getDisabledEntities();
  if (disallowed.Chat === false) {
    log('Skipping "Chat"');
    return 0;
  }

  const policies = await getPolicies();
  const policyId = getPolicyFor('Chat', policies);
  if (!policyId) {
    logAx({ message: 'No policy id found for "Chat"' });
    throw new Error('No policy id found for "Chat"');
  }

  // special case, not using JobQueue

  const data = await dbRead.chatMessage.findMany({
    select: {
      id: true,
      userId: true,
      chatId: true,
      content: true,
      createdAt: true,
    },
    where: {
      createdAt: { gt: lastRun },
      userId: { not: -1 },
      contentType: ChatMessageType.Markdown,
    },
    orderBy: {
      createdAt: 'asc',
    },
    // take: 200,
  });
  // .catch((error) => {
  //   logAx({ message: 'Error getting chat messages', data: { error } });
  //   return [];
  // });

  if (!data || data.length === 0) {
    log('No chat messages found');
    return 0;
  }

  const { use, modWordBlocklist, modURLBlocklist } = await getBlocklists();

  const badMessages = data.filter((d) =>
    hasIssue(d.content, modWordBlocklist, modURLBlocklist, use, 'Chat')
  );

  if (badMessages.length > 0) {
    const chatUserIds: Record<string, Set<number>> = {};
    const chatSenders: Record<string, Record<number, ChatSender>> = {};
    const badMessagesByChat = badMessages.reduce((acc, cur) => {
      const key = `${cur.chatId}`;
      if (!acc[key]) {
        acc[key] = `[${cur.userId}]: ${cur.content}`;
      } else {
        acc[key] += ` | [${cur.userId}]: ${cur.content}`;
      }
      if (!chatUserIds[key]) chatUserIds[key] = new Set();
      chatUserIds[key].add(cur.userId);
      const senders = (chatSenders[key] ??= {});
      const latest = senders[cur.userId];
      if (!latest || cur.id > latest.messageId)
        senders[cur.userId] = { messageId: cur.id, at: cur.createdAt };
      return acc;
    }, {} as Record<string, string>);

    await runClavata({
      policyId,
      type: 'Chat',
      data: Object.entries(badMessagesByChat).map(([key, value]) => ({
        id: Number(key),
        userId: -1, // we are parsing multiple chats at once, so we can't know who is responsible
        userIds: Array.from(chatUserIds[key] ?? []),
        senders: chatSenders[key],
        value,
      })),
      deleteJob: false,
    });
  }

  return data.length;
}

async function runModQueue() {
  const policies = await getPolicies();
  const disallowed = await getDisabledEntities();

  const policyMap: { -readonly [key in keyof typeof queues]?: string } = {};
  for (const key of Object.keys(queues) as (keyof typeof queues)[]) {
    if (disallowed[key] === false) {
      log(`Skipping "${key}"`);
      continue;
    }

    const policy = getPolicyFor(key, policies);
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

  const { use, modWordBlocklist, modURLBlocklist } = await getBlocklists();

  const validQueues = Object.keys(policyMap) as QueueKeys[];

  // TODO we should periodically check if any jobQueues get "stuck" for a while
  const queueRows = await dbRead.jobQueue.findMany({
    select: {
      entityType: true,
      entityId: true,
    },
    where: {
      type: JobQueueType.ModerationRequest,
      entityType: { in: validQueues },
      // createdAt: { gt: lastRun },
    },
  });

  type EntityIdMap = { [key in EntityType]?: number[] };

  const aggedRows: EntityIdMap = queueRows.reduce((prev, curr) => {
    const table = curr.entityType;
    const arr = prev[table] ?? [];
    arr.push(curr.entityId);
    prev[table] = arr;
    return prev;
  }, {} as EntityIdMap);

  async function processEntityType(entityType: keyof typeof queues) {
    log(`Starting ${jobName}-${entityType}`);
    const ids = aggedRows[entityType];

    if (!ids?.length) {
      log(`Finished ${jobName}-${entityType}, no items`);
      return;
    }

    try {
      const {
        fields,
        selector,
        idKey = 'id',
        userIdKey = 'userId',
      } = queues[entityType] as EntityQueueConfig;

      if (!selector || typeof selector.findMany !== 'function') {
        logAx({ message: `No model found for entity type: ${entityType}` });
        return;
      }

      const data: ({ [entityIdKey: string]: number } & { [key in keyof typeof fields]: string })[] =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (selector as any).findMany({
          where: { [idKey]: { in: ids } },
          select: { [idKey]: true, [userIdKey]: true, ...fields },
        });

      const missingIds = ids.filter((id) => !data.some((d) => d[idKey] === id));
      if (missingIds.length > 0) {
        log(`Deleting missing ids (${missingIds.length})`);
        await deleteFromJobQueue(entityType, missingIds);
      }

      for (const col of Object.keys(fields) as (keyof typeof fields)[]) {
        const { goodData, badData } = data.reduce(
          (acc, d) => {
            if (hasIssue(d[col], modWordBlocklist, modURLBlocklist, use, entityType)) {
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
}

async function modChat() {
  const [lastRun, setLastRun] = await getJobDate(`${jobName}-${jobNameChat}`);
  log(`Starting ${jobName}-${jobNameChat}`);
  try {
    const handled = await runModChat(
      new Date(Math.max(lastRun.getTime(), new Date(minDate).getTime())) // avoid fetching all old messages
    );
    log(`Finished ${jobName}-${jobNameChat}, processed ${handled} items`);
    await setLastRun();
  } catch (error) {
    logAx({ message: 'Error handling chat', data: { error } });
  }
}

async function modQueue() {
  const [, setLastRun] = await getJobDate(`${jobName}-${jobNameQueues}`);
  log(`Starting ${jobName}-${jobNameQueues}`);
  try {
    await runModQueue();
    log(`Finished ${jobName}-${jobNameQueues}`);
    await setLastRun();
  } catch (error) {
    logAx({ message: 'Error handling queues', data: { error } });
  }
}

async function clearAutomated() {
  const [, setLastRun] = await getJobDate(`${jobName}-${jobNameClear}`);
  log(`Starting ${jobName}-${jobNameClear}`);
  try {
    const { closed, deleted } = await clearAutomatedReports(
      dayjs().subtract(AUTOMATED_REPORT_RETENTION_DAYS, 'day').toDate()
    );

    log(
      `Finished ${jobName}-${jobNameClear}, closed ${closed} reports, deleted ${deleted} payloads`
    );
    await setLastRun();
  } catch (error) {
    logAx({ message: 'Error deleting old reports', data: { error } });
  }
}

//

const modChatJob = createJob(`${jobName}-${jobNameChat}`, '*/5 * * * *', modChat);
const modQueueJob = createJob(`${jobName}-${jobNameQueues}`, '*/5 * * * *', modQueue);
const clearAutomatedJob = createJob(`${jobName}-${jobNameClear}`, '0 6 * * *', clearAutomated);

export const entityModerationJobs = [modChatJob, modQueueJob, clearAutomatedJob];
