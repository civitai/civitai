import { MeiliSearch } from 'meilisearch';
import { env } from '~/env/server.mjs';
import { createLogger } from '~/utils/logging';

const log = createLogger('search', 'green');

const shouldConnect = !!env.SEARCH_HOST && !!env.SEARCH_API_KEY;
export const client = shouldConnect
  ? new MeiliSearch({
      host: env.SEARCH_HOST as string,
      apiKey: env.SEARCH_API_KEY,
    })
  : null;
