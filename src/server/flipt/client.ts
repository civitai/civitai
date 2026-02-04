import { FliptClient } from '@flipt-io/flipt-client-js';
import { env } from '~/env/server';
import { logToAxiom } from '../logging/client';

// Re-export from shared location for backwards compatibility
export { FLIPT_FEATURE_FLAGS } from '~/shared/constants/feature-flags';

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
          updateInterval: 60, // Fetch feature flag updates (default: 120 seconds)
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

export async function isFlipt(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
) {
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return false;

  try {
    const evaluation = fliptClient.evaluateBoolean({
      flagKey: flag,
      entityId,
      context,
    });

    return evaluation.enabled;
  } catch (e) {
    console.error('Flipt evaluation error:', e);
    return false;
  }
}

export async function getFliptVariant(
  flag: string,
  entityId = 'global',
  context: Record<string, string> = {}
): Promise<string | null> {
  const fliptClient = await FliptSingleton.getInstance();
  if (!fliptClient) return null;

  try {
    const evaluation = fliptClient.evaluateVariant({
      flagKey: flag,
      entityId,
      context,
    });

    return evaluation.variantKey;
  } catch (e) {
    console.error('Flipt variant evaluation error:', e);
    return null;
  }
}

export default FliptSingleton;
