import { FliptClient } from '@flipt-io/flipt-client-js';
import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';

export enum FLIPT_FEATURE_FLAGS {
  FEED_IMAGE_EXISTENCE = 'feed-image-existence',
  ENTITY_METRIC_NO_CACHE_BUST = 'entity-metric-no-cache-bust',
}

class FliptSingleton {
  private static instance: FliptClient | null = null;
  private static initializing: Promise<FliptClient | null> | null = null;

  private constructor() {
    // Prevent direct construction
  }

  static async getInstance(): Promise<FliptClient | null> {
    if (this.instance) {
      return this.instance;
    }

    if (this.initializing) {
      // If initialization is already in progress, wait for it
      return this.initializing;
    }

    this.initializing = (async () => {
      try {
        const internalAuthHeader = env.FLIPT_FETCHER_SECRET;

        const fliptClient = await FliptClient.init({
          environment: 'civitai-app',
          url: env.FLIPT_URL,
          authentication: {
            clientToken: internalAuthHeader,
          },
        });

        await fliptClient.refresh();
        this.instance = fliptClient;
        return this.instance;
      } catch (e) {
        const err = e as Error;

        logToAxiom(
          {
            type: 'init-flipt-error',
            error: err.message,
            cause: err.cause,
            stack: err.stack,
          },
          'temp-search'
        ).catch();

        this.instance = null;
        return null;
      } finally {
        this.initializing = null;
      }
    })();

    return this.initializing;
  }
}

export default FliptSingleton;
