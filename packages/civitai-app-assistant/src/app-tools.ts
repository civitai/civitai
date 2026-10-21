import type { AssistantTool } from './tool';
import { appKeyBase, newAppKey } from './app-key';
import type { Sandbox } from './sandbox-client';
import { SandboxApiError, isRunningLimit } from './sandbox-client';

export const CREATE_APP = 'create_app';

// The chat shows the user every refusal and thrown error, so these are written for them to read too:
// no tool names, ids or service wording.
export const NO_APP_REFUSAL =
  'There is no app yet to plan features for. Start the app the user described first, then list its features.';
export const APPS_LOADING = 'Your apps are still loading. Try again in a moment.';
export const KEEP_LIMIT =
  'You already have as many apps as you can keep. Delete one you no longer need from the app switcher at the top of the page, then ask again.';
// openApp pauses the others and retries once, so this is that retry refused.
export const RUNNING_LIMIT =
  'Another of your apps started at the same moment, so this one could not. Ask again: starting this app pauses the others.';
export const APPS_CHANGING = 'Your apps were changing at the same moment. Try again.';
export const APPS_UNREACHABLE = 'Your apps could not be reached right now. Try again in a moment.';

/** What the user may read about a failed open; never the service's own message. */
export function appOpenFailure(error: unknown): string {
  if (isRunningLimit(error)) return RUNNING_LIMIT;
  if (error instanceof SandboxApiError && error.kind === 'limit') return KEEP_LIMIT;
  if (error instanceof SandboxApiError && error.kind === 'conflict') return APPS_CHANGING;
  return APPS_UNREACHABLE;
}

export interface AppToolsOptions {
  /** The user's apps as last listed; undefined until the list has loaded. */
  apps: () => Sandbox[] | undefined;
  /** The app open on the page, if any. */
  current: () => Sandbox | null;
  /** Creates (or, when it exists after all, resumes) the app's sandbox and makes it the open app. */
  open: (app: string) => Promise<{ sandbox: Sandbox; created: boolean }>;
}

type CreateResult = { app: string; state: Sandbox['state']; existed?: true; note: string };

export interface AppTools {
  tools: Record<string, AssistantTool>;
  /** Why a call may not run now: create_app again in the reply where it hit a limit. */
  refusal(name: string): string | null;
  /** A new reply began; a limit hit in the last one may be worth trying again. */
  newReply(): void;
  /** The page deleted this sandbox. */
  forget(name: string): void;
}

export function createAppTools({ apps, current, open }: AppToolsOptions): AppTools {
  // The chat runs a step's calls together; a second create must not race the first to the service,
  // which would make two apps under one name.
  let pending: Promise<CreateResult> | null = null;
  // Retrying cannot clear a limit within a reply, and a running-limit retry pauses the user's apps again.
  let limited: string | null = null;
  // The name each app this page created was asked for, as a key: a numbered copy's key alone cannot
  // be told from a name that ends in digits ("Room 101"). Kept per sandbox (the service generates a
  // new name for every creation) and its creation time, so a different app later made under the same
  // key is not mistaken for it.
  const askedFor = new Map<string, { base: string; createdAt: string | null }>();
  const recordCreated = (sandbox: Sandbox, base: string) =>
    askedFor.set(sandbox.name, { base, createdAt: sandbox.createdAt });
  const recordedBase = (sandbox: Sandbox) => {
    const record = askedFor.get(sandbox.name);
    return record && record.createdAt === sandbox.createdAt ? record.base : undefined;
  };

  const openOrExplain = async (app: string) => {
    try {
      return await open(app);
    } catch (error) {
      const message = appOpenFailure(error);
      if (error instanceof SandboxApiError && error.kind === 'limit') limited = message;
      throw new Error(message);
    }
  };

  const create = async (name: string): Promise<CreateResult> => {
    const list = apps();
    if (!list) throw new Error(APPS_LOADING);
    const openNow = current();
    const base = appKeyBase(name);
    const listed = new Set(list.map((s) => s.name));
    // Gone from the list: deleted, perhaps elsewhere.
    for (const key of askedFor.keys()) if (!listed.has(key)) askedFor.delete(key);
    // Asked again for the app that is open: keep it rather than make another. An app opened from the
    // list matches only by its exact key; failing that a new app is made, which overwrites nothing.
    if (openNow && (openNow.app === base || recordedBase(openNow) === base)) {
      if (openNow.state !== 'suspended')
        return {
          app: openNow.app,
          state: openNow.state,
          existed: true,
          note: `The app ${openNow.app} is already open; keep working on it.`,
        };
      const resumed = await openOrExplain(openNow.app);
      // The list can be a minute old; a paused app it still showed may have been deleted since.
      if (resumed.created) {
        recordCreated(resumed.sandbox, base);
        return {
          app: openNow.app,
          state: resumed.sandbox.state,
          note: `The app ${openNow.app} had been deleted after it was paused, so a new, empty app was made under the same name. Tell the user its files are gone and ask them to tap Build it or say what to change, then call set_checklist with the features they asked for; its tools arrive with your next reply.`,
        };
      }
      return {
        app: openNow.app,
        state: resumed.sandbox.state,
        existed: true,
        note: `The app ${openNow.app} was paused and is starting again; its tools arrive with your next reply. Keep working on it.`,
      };
    }
    const app = newAppKey(
      name,
      list.map((s) => s.app)
    );
    const opened = await openOrExplain(app);
    const { sandbox, created } = opened;
    // Only what this page made: an app the service found is the user's own, made elsewhere.
    if (created) recordCreated(sandbox, base);
    // The list it was named against can be stale, and the service finds before it creates.
    if (!created)
      return {
        app,
        state: sandbox.state,
        existed: true,
        note: `The user already had an app called ${app}, made somewhere else after this page last listed their apps, and it is now open instead of a new one. Ask the user whether to keep working on it; do not build over it before they answer.`,
      };
    return {
      app,
      state: sandbox.state,
      note: `The app ${app} is starting, and ${app} is also its blockId. Its tools arrive with your next reply, so now write one short sentence asking the user to tap Build it or say what to change, then call set_checklist with the features they asked for; that ends this reply.`,
    };
  };

  const create_app: AssistantTool = {
    description:
      'Start a new app for the user and open it. Call it once, before anything else, when the user describes an app to build and no app is open, or when they ask for a different app than the open one. Never call it for a question that builds nothing.',
    activity: 'Setting up your app…',
    inputSchema: {
      properties: {
        name: {
          type: 'string',
          description:
            'A short name for the app in two to four words, taken from the user’s request, e.g. "Tip calculator". It becomes the app’s id.',
        },
      },
      required: ['name'],
    },
    execute(input) {
      if (pending) return pending;
      pending = create(typeof input.name === 'string' ? input.name : '').finally(() => {
        pending = null;
      });
      return pending;
    },
  };
  return {
    tools: { [CREATE_APP]: create_app },
    refusal: (name) => (name === CREATE_APP ? limited : null),
    newReply: () => {
      limited = null;
    },
    forget: (name) => {
      askedFor.delete(name);
    },
  };
}
