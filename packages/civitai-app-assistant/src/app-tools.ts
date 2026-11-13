import type { AssistantTool } from './tool';
import { appKeyBase, newAppKey } from './app-key';
import type { Sandbox } from './sandbox-client';
import { SandboxApiError, isRunningLimit } from './sandbox-client';
import {
  keptAppsMessage,
  keptAppsOf,
  limitCardOfError,
  sleepingLimitMessage,
  sleepingLimitOldestOf,
  sleepingNotLive,
  wakeOnlyFailure,
  safeOldest,
  type LimitCard,
  type OfferContext,
  type SleepingApp,
  type WakeResult,
} from './sleeping-apps';

/**
 * App hibernate's cap refusals (`sleeping_limit`, `kept_apps`), which a service without
 * hibernation never sends: the tool RETURNS `{ error, limitCard }` (the chat reports any output
 * with an `error` as failed) so the page's card reads a structured field, never the wording.
 */
class LimitRefusal extends Error {
  constructor(message: string, readonly card: LimitCard) {
    super(message);
  }
}
const isHibernateCapRefusal = (error: unknown) =>
  (error instanceof SandboxApiError && error.code === 'sleeping_limit') || !!keptAppsOf(error);
const limitRefusalOutput = (error: LimitRefusal) => ({
  error: error.message,
  limitCard: error.card,
});

export const CREATE_APP = 'create_app';
export const USE_OPEN_APP = 'use_open_app';
/** App hibernate: the user's apps, kept and sleeping (read-only). */
export const LIST_APPS = 'list_apps';
/** App hibernate: wakes one sleeping app and opens it. */
export const WAKE_APP = 'wake_app';

// The chat shows the user every refusal and thrown error, so these are written for them to read too:
// no tool names, ids or service wording.
export const NO_APP_REFUSAL =
  'There is no app yet to plan features for. Start the app the user described first, then list its features.';
export const APPS_LOADING = 'Your apps are still loading. Try again in a moment.';
export const KEEP_LIMIT =
  'You already have as many apps as you can keep. Choose one to delete in the card under the chat; your request then continues automatically.';
/**
 * Every wording of KEEP_LIMIT a released server runner sends. The runner bundles this package when it
 * is released, and the page ships on its own schedule, so the page reads what a deployed runner says,
 * not only the wording it was built with. When KEEP_LIMIT changes, add its old wording here; remove
 * one only once no deployed runner is at or below the last release that sends it.
 */
const KEEP_LIMIT_WORDINGS: ReadonlySet<string> = new Set([
  KEEP_LIMIT,
  // assistant-runner v0.0.10 to v0.0.15.
  'You already have as many apps as you can keep. Choose one to delete in the card under the chat, and your message is sent again.',
  // assistant-runner v0.0.2 to v0.0.9.
  'You already have as many apps as you can keep. Delete one you no longer need from the app switcher at the top of the page, then ask again.',
]);
// openApp pauses the others and retries once, so this is that retry refused.
export const RUNNING_LIMIT =
  'Another of your apps started at the same moment, so this one could not. Ask again: starting this app pauses the others.';
export const APPS_CHANGING = 'Your apps were changing at the same moment. Try again.';
export const APPS_UNREACHABLE = 'Your apps could not be reached right now. Try again in a moment.';
/** use_open_app with no app open. */
export const NO_OPEN_APP = 'No app is open, so there is none to change. Start a new app instead.';
/**
 * use_open_app in a reply where making a new app failed: the open app is not changed in its place.
 * A new reply (the user's answer) may choose it.
 */
export const NEW_APP_FAILED_KEEP_OPEN =
  'A new app could not be made just now, so your open app was left as it is. Do what the message above says, then ask again.';

/** What the user may read about a failed open; never the service's own message. */
export function appOpenFailure(error: unknown, ctx: OfferContext = {}): string {
  if (isRunningLimit(error)) return RUNNING_LIMIT;
  // App hibernate's two kept-cap refusals; a service without hibernation never sends either.
  if (error instanceof SandboxApiError && error.code === 'sleeping_limit')
    return sleepingLimitMessage(safeOldest(sleepingLimitOldestOf(error), ctx));
  const kept = keptAppsOf(error);
  if (kept) return keptAppsMessage(kept);
  if (error instanceof SandboxApiError && error.kind === 'limit') return KEEP_LIMIT;
  if (error instanceof SandboxApiError && error.kind === 'conflict') return APPS_CHANGING;
  return APPS_UNREACHABLE;
}

/**
 * Whether a finished tool call, as the page is told of it (the browser's `tool-result`, or the server
 * runner's `tool-reported`), is `create_app` refused at the cap on apps kept: thrown by the tool, or
 * refused by the gate for the rest of that reply, in any released runner's wording (`KEEP_LIMIT_WORDINGS`).
 * Never the running-app cap, which `openApp` handles by pausing. The one place the page tells it.
 */
export function isKeepLimitResult(result: {
  name: string;
  output: unknown;
  isError: boolean;
}): boolean {
  if (result.name !== CREATE_APP || !result.isError) return false;
  const output = result.output;
  if (output === null || typeof output !== 'object') return false;
  const error = (output as { error?: unknown }).error;
  return typeof error === 'string' && KEEP_LIMIT_WORDINGS.has(error);
}

/**
 * The card a finished `create_app` or `wake_app` call that hit the cap on apps kept asks the page
 * for: `keep` (pick a kept app to delete: `FreeUpSlotCard`), or `sleeping` (the user's sleeping
 * apps are at their limit: offer to delete the `oldest`, once they confirm). `null` for anything
 * else. Read from the result's structured `limitCard` (what the page hears of a runner's call
 * too), or, for the plain kept-app cap, `isKeepLimitResult`'s released wordings.
 */
export function limitCardOf(result: {
  name: string;
  output: unknown;
  isError: boolean;
}): LimitCard | null {
  if (isKeepLimitResult(result)) return { kind: 'keep' };
  if ((result.name !== CREATE_APP && result.name !== WAKE_APP) || !result.isError) return null;
  const output = result.output as { error?: unknown; limitCard?: unknown } | null;
  const card = output?.limitCard as { kind?: unknown; oldest?: unknown } | null | undefined;
  if (card?.kind === 'sleeping')
    return {
      kind: 'sleeping',
      oldest: typeof card.oldest === 'string' && card.oldest ? card.oldest : null,
    };
  if (card?.kind === 'keep' || output?.error === KEEP_LIMIT) return { kind: 'keep' };
  return null;
}

export interface AppToolsOptions {
  /** The user's apps as last listed; undefined until the list has loaded. */
  apps: () => Sandbox[] | undefined;
  /** The app open on the page, if any. */
  current: () => Sandbox | null;
  /** Creates (or, when it exists after all, resumes) the app's sandbox and makes it the open app. */
  open: (app: string) => Promise<{ sandbox: Sandbox; created: boolean }>;
  /**
   * Resolves `true` once the reply can be given a new app's own tools by building its tools again
   * (`reopenTools`): the page, once the app runs and its tools are handed to the chat; the server
   * runner at once, as it opens the app the reply chose when it builds them. `false` (or unset): they
   * arrive with the next reply.
   */
  toolsReady?: (app: string) => Promise<boolean>;
  /**
   * App hibernate (the `app-hibernate` flag on): the user's sleeping apps as last listed, undefined
   * until listed. Set together with `wake`, the tools add `list_apps` and `wake_app`, and
   * `create_app` keeps clear of sleeping apps' names. Unset, the tools are exactly as before.
   */
  sleeping?: () => SleepingApp[] | undefined;
  /** Wakes a sleeping app (`wakeSleepingApp`) and makes it the open app. */
  wake?: (app: string) => Promise<WakeResult>;
}

/** A new app whose tools the reply gets now (`reopenTools`): it goes straight on to plan and build. */
const newAppReady = (app: string, intro: string) =>
  `${intro} ${app} is also its blockId. Its tools are ready for this reply: call set_checklist with the features the user asked for, as your plan, then build it straight away. Ask the user only if their request is ambiguous or needs a decision from them.`;
/** A new app whose tools come only with the next reply: this reply ends here (`awaitsUser`). */
const newAppNotReady = (app: string, intro: string) =>
  `${intro} ${app} is also its blockId. It is still starting, so its tools arrive with your next reply, and this reply ends here: the user sees their app is starting, and you plan and build it (set_checklist first) as soon as they reply.`;

/** What a create_app that made no new app adds: it does not choose the app for the chat. */
const CHOOSE_FIRST =
  'Changes to it are refused until it is chosen: call use_open_app first if this chat has not, and only if the user asked to change it.';

type CreateResult = {
  app: string;
  state: Sandbox['state'] | 'sleeping';
  existed?: true;
  note: string;
  /** The reply carries on with its tools built again, the new app's included (components-chat). */
  reopenTools?: true;
  /** The reply ends here (components-chat): the new app's tools come only with the next reply. */
  awaitsUser?: true;
};

export interface AppTools {
  tools: Record<string, AssistantTool>;
  /**
   * Why a call may not run now: create_app again in the reply where it hit a limit, and use_open_app
   * in a reply where create_app failed (the open app is never changed in place of a new one).
   */
  refusal(name: string): string | null;
  /** A new reply began; a limit hit in the last one may be worth trying again. */
  newReply(): void;
  /** The page deleted this sandbox. */
  forget(name: string): void;
}

export function createAppTools({
  apps,
  current,
  open,
  toolsReady,
  sleeping,
  wake,
}: AppToolsOptions): AppTools {
  const hibernate = sleeping && wake ? { sleeping, wake } : null;
  // The chat runs a step's calls together; a second create of the same name must not race the first
  // to the service, which would make two apps under one name. Only that one joins it, and only until
  // its app exists (`release`): never a create of another name, nor one after a Stop or in another
  // chat while the first still waits for its app's tools.
  let pending: { base: string; result: Promise<CreateResult> } | null = null;
  // Retrying cannot clear a limit within a reply, and a running-limit retry pauses the user's apps again.
  let limited: string | null = null;
  // A create_app of this reply failed: the open app must not be chosen in its place.
  let createFailed = false;
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

  /** What a new app's create_app answers: its tools now (`reopenTools`) when they are ready. */
  const madeNew = async (
    app: string,
    state: Sandbox['state'],
    intro: string,
    release: () => void
  ): Promise<CreateResult> => {
    // The app exists: a later create_app no longer joins this one while it waits for the tools.
    release();
    const ready = (await toolsReady?.(app).catch(() => false)) === true;
    return ready
      ? { app, state, note: newAppReady(app, intro), reopenTools: true }
      : { app, state, note: newAppNotReady(app, intro), awaitsUser: true };
  };

  /**
   * What a limit offer for `app` must leave out (`safeOldest`): the app being opened or woken, and
   * every app awake now. With the apps or the sleeping apps unread (the runner's list refused past
   * its rate limit reads as `null`, so no `sleeping` here), nothing is offered: fail closed.
   */
  const offerContext = (app: string): OfferContext => {
    const list = apps();
    return {
      app,
      live: (list ?? []).map((s) => s.app),
      ...(!list || !hibernate?.sleeping() ? { unknown: true } : {}),
    };
  };

  const openOrExplain = async (app: string) => {
    try {
      return await open(app);
    } catch (error) {
      const ctx = offerContext(app);
      const message = appOpenFailure(error, ctx);
      if (error instanceof SandboxApiError && error.kind === 'limit') limited = message;
      const card = isHibernateCapRefusal(error) ? limitCardOfError(error, ctx) : null;
      throw card ? new LimitRefusal(message, card) : new Error(message);
    }
  };

  const create = async (name: string, release: () => void): Promise<CreateResult> => {
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
          note: `The app ${openNow.app} is already open; keep working on it. ${CHOOSE_FIRST}`,
        };
      const resumed = await openOrExplain(openNow.app);
      // The list can be a minute old; a paused app it still showed may have been deleted since.
      if (resumed.created) {
        recordCreated(resumed.sandbox, base);
        return madeNew(
          openNow.app,
          resumed.sandbox.state,
          `The app ${openNow.app} had been deleted after it was paused, so a new, empty app was made under the same name: tell the user its files are gone.`,
          release
        );
      }
      return {
        app: openNow.app,
        state: resumed.sandbox.state,
        existed: true,
        note: `The app ${openNow.app} was paused and is starting again; its tools arrive with your next reply. Keep working on it. ${CHOOSE_FIRST}`,
      };
    }
    // App hibernate: a sleeping app's name is taken too (a new app under it would block that app's
    // next sleep), and a request naming one is answered with the offer to wake it.
    const asleep = hibernate ? sleepingNotLive(list, hibernate.sleeping() ?? []) : [];
    if (asleep.some((s) => s.app === base))
      return {
        app: base,
        state: 'sleeping',
        existed: true,
        note: `The user has a sleeping app called ${base}: its files are kept, and wake_app wakes it with them. No app was made or changed. Ask the user whether to wake ${base} or make a new app; for a new one, call create_app again with a name that differs from ${base}.`,
      };
    const app = newAppKey(name, [...list.map((s) => s.app), ...asleep.map((s) => s.app)]);
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
        note: `The user already had an app called ${app}, made somewhere else after this page last listed their apps, and it is now open instead of a new one. Ask the user whether to keep working on it; do not build over it before they answer, and call use_open_app only if they say yes.`,
      };
    return madeNew(app, sandbox.state, `The app ${app} was made.`, release);
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
      const name = typeof input.name === 'string' ? input.name : '';
      const base = appKeyBase(name);
      if (pending?.base === base) return pending.result;
      const entry: { base: string; result: Promise<CreateResult> } = {
        base,
        result: Promise.resolve(null as never),
      };
      const release = () => {
        if (pending === entry) pending = null;
      };
      entry.result = create(name, release)
        .catch((error: unknown) => {
          createFailed = true;
          if (error instanceof LimitRefusal) return limitRefusalOutput(error) as never;
          throw error;
        })
        .finally(release);
      pending = entry;
      return entry.result;
    },
  };
  /** `list_apps` and `wake_app` (app hibernate). */
  const sleepingAppTools = ({
    sleeping: listSleeping,
    wake: wakeApp,
  }: {
    sleeping: () => SleepingApp[] | undefined;
    wake: (app: string) => Promise<WakeResult>;
  }): Record<string, AssistantTool> => ({
    [LIST_APPS]: {
      description:
        'List the user’s apps: the kept ones (running, starting or paused) and the sleeping ones, with when each was last used. A sleeping app keeps its files and can be woken with wake_app. Read-only.',
      activity: 'Looking at your apps…',
      inputSchema: { properties: {} },
      execute() {
        const list = apps();
        if (!list) throw new Error(APPS_LOADING);
        const asleep = sleepingNotLive(list, listSleeping() ?? []);
        return {
          apps: [
            ...list.map((s) => ({
              app: s.app,
              state: s.state === 'suspended' ? 'paused' : s.state,
              lastUsed: s.lastActivityAt,
            })),
            ...asleep.map((s) => ({
              app: s.app,
              state: 'sleeping',
              lastUsed: s.lastActivityAt,
              asleepSince: s.hibernatedAt,
            })),
          ],
        };
      },
    },
    [WAKE_APP]: {
      description:
        'Wake one of the user’s sleeping apps (list_apps shows them) and open it with its files, to keep working on it. Call it only when the user asks to work on that app. Its dependencies are not kept while it sleeps, so after waking it, run npm install in it first.',
      activity: 'Waking your app…',
      inputSchema: {
        properties: {
          app: { type: 'string', description: 'The sleeping app’s key, as list_apps names it.' },
        },
        required: ['app'],
      },
      async execute(input) {
        const app = typeof input.app === 'string' ? input.app : '';
        const list = apps();
        if (!list) throw new Error(APPS_LOADING);
        const awake = list.find((s) => s.app === app);
        if (awake)
          return {
            app,
            state: awake.state,
            existed: true,
            note: `${app} is not asleep: it is one of the user’s kept apps. ${CHOOSE_FIRST}`,
          };
        if (!sleepingNotLive(list, listSleeping() ?? []).some((s) => s.app === app))
          throw new Error(
            `There is no sleeping app called ${app}. Call list_apps to see the user’s apps.`
          );
        let woken: WakeResult;
        try {
          woken = await wakeApp(app);
        } catch (error) {
          createFailed = true;
          const ctx = offerContext(app);
          const message = wakeOnlyFailure(error) ?? appOpenFailure(error, ctx);
          if (error instanceof SandboxApiError && error.kind === 'limit') limited = message;
          const card = limitCardOfError(error, ctx);
          if (card) return limitRefusalOutput(new LimitRefusal(message, card));
          throw new Error(message);
        }
        const state = woken.sandbox.state;
        const ready = (await toolsReady?.(app).catch(() => false)) === true;
        const intro = woken.alreadyAwake
          ? `${app} had already been woken elsewhere and is now open, with its files.`
          : `${app} was woken from sleep and is now open, with its files (its .env files included).`;
        // The archive it was woken from (absent when it was already awake): a page following a
        // runner's wake records it as the sandbox's lineage, so deleting the app there takes the
        // record with it (`sleepLineage.ts`).
        const lineage = woken.sha256 ? { sha256: woken.sha256 } : {};
        const reinstall = `Its dependencies (node_modules), build output and caches were not kept while it slept, so before anything else run cd ${app} && npm install (if ${app} is not the project folder, find it with sandbox__list_dir first).`;
        return ready
          ? {
              app,
              state,
              woke: true,
              ...lineage,
              note: `${intro} ${reinstall} Its tools are ready for this reply: then carry on with what the user asked.`,
              reopenTools: true,
            }
          : {
              app,
              state,
              woke: true,
              ...lineage,
              note: `${intro} It is still starting, so its tools arrive with your next reply, and this reply ends here: tell the user it is waking up. ${reinstall}`,
              awaitsUser: true,
            };
      },
    },
  });

  // The gate (`createGateCore`'s `openApp`) refuses every change to the open app in a chat that did
  // not create it or choose it with this: a new chat with an app open must not build over that app.
  const use_open_app: AssistantTool = {
    description:
      'Choose the open app as the app this chat changes. Changes to the open app are refused in a chat until it was made with create_app in that chat or chosen with this. Call it only when the user clearly asked to change the open app itself (named it, or asked to change something it already has), or said yes when you asked whether to replace it. Never call it for a different app, even in a chat about the open app: call create_app for that. When it is not clear which they mean, ask "Make a new app, or replace <app>?" and wait for their answer.',
    activity: 'Opening your app for changes…',
    inputSchema: {
      properties: {
        app: { type: 'string', description: 'The open app’s key, as the instructions name it.' },
      },
      required: ['app'],
    },
    execute(input) {
      const openNow = current();
      if (!openNow) throw new Error(NO_OPEN_APP);
      if (input.app !== openNow.app)
        throw new Error(
          `The app open now is ${openNow.app}, not ${String(input.app)}. Ask which app to change.`
        );
      return {
        app: openNow.app,
        note: `This chat may now change ${openNow.app}.`,
      };
    },
  };
  return {
    tools: {
      [CREATE_APP]: create_app,
      [USE_OPEN_APP]: use_open_app,
      ...(hibernate ? sleepingAppTools(hibernate) : {}),
    },
    refusal: (name) =>
      name === CREATE_APP || name === WAKE_APP
        ? limited
        : name === USE_OPEN_APP && createFailed
        ? NEW_APP_FAILED_KEEP_OPEN
        : null,
    newReply: () => {
      limited = null;
      createFailed = false;
    },
    forget: (name) => {
      askedFor.delete(name);
    },
  };
}
