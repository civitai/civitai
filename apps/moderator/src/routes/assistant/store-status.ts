import { storeUnavailableMessage, type ModeratorDbStatus } from '$lib/moderator-db-status';

/** What every assistant page says when its tables cannot be read. */
export const assistantStoreMessage = (status: Exclude<ModeratorDbStatus, 'ok'>) =>
  storeUnavailableMessage(status, {
    tables: 'The assistant’s tables',
    database: 'the moderator database',
    schemaFile: 'apps/moderator/assistant/schema.sql',
  });
