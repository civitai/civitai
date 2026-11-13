import { randomUUID } from 'node:crypto';

import {
  APP_FEEDBACK_TOOLS,
  CREATE_APP,
  NO_APP_REFUSAL,
  REPORT_READY,
  SET_CHECKLIST,
  START_PREVIEW,
  SUBMIT_FOR_REVIEW,
  USE_OPEN_APP,
  appAssistantSubagents,
  assistantSystemPrompt,
  buildAssistantInstructions,
  createAppTools,
  createDocsTool,
  createFeedbackTools,
  createGateCore,
  createSourceSaveScheduler,
  chosenAppOf,
  createSandboxClient,
  openApp,
  GENERATE_APP_COVER,
  LIST_APPS,
  READ_DOCS,
  WAKE_APP,
  sleepingNotLive,
  startOrWakeApp,
  wakeSleepingApp,
  type CoverEstimator,
  unconfiguredFeedbackSource,
  type AppFeedbackSource,
  type Sandbox,
  type SleepingApp,
  type ToolResult,
} from '@civitai/app-assistant';
import {
  DISPATCH_AGENT,
  SubagentTracker,
  dispatchAgentTool,
  gateToolSet,
  hostToolSet,
  nextReply,
  outputTokenCap,
  resolveSubagents,
  subagentToolNames,
  type ChatTool,
  type GateDeps,
  type SubagentProgress,
} from '@civitai/components-chat/core';
import type { ChatToolResult, RunPageState } from '@civitai/components-chat/runner-protocol';
import type { ToolSet } from 'ai';

import type { Logger, OpenTools, ToolContext, ToolProvider } from '../core/interfaces';
import { MintRefusedError, type TokenSource } from '../minter';
import {
  RUNNER_ACTIVITY_TOOLS,
  runnerActivityTools,
  type CivitaiAppActivity,
} from './app-activity';
import { runnerCoverTools, unconfiguredCoverTools, type CoverListings } from './cover';
import { DevTunnelError, type DevTunnels } from './dev-tunnel';
import { toolResultsOf } from './history';
import { RunnerPreview, type AutoPreview } from './preview';
import { AppSandbox } from './sandbox';
import { unjustifiedManifestScopes } from './scope-justifications';
import { SdkUpgrades, upgradeBeforeSubmit } from './sdk-pin';
import type { RunSleepingApps } from './sleeping-apps';

/**
 * What App Assistant's page says about itself as a reply starts (`remoteRunner.pageState`): the key
 * of the app open in it, or `null`. Only that, and never trusted: the runner looks the key up among
 * the user's own sandboxes with the user's own token, so a key the user has no sandbox for (or any
 * other value) opens nothing.
 */
export interface AppAssistantPageState {
  app: string | null;
  /**
   * App hibernate: the user woke the open app from sleep on the page, so its dependencies need
   * installing again. A hint for the instructions only; the page sends it only with the flag on.
   */
  woken?: true;
}

/** The page's state as the runner reads it; anything but a string is no app open. */
export function readPageState(page: RunPageState | undefined): AppAssistantPageState {
  const app = page?.app;
  const open = typeof app === 'string' && app.length > 0 && app.length <= 200 ? app : null;
  return open && page?.woken === true ? { app: open, woken: true } : { app: open };
}

/**
 * A finished call as the page is told of it (`tool-reported`): what its own gate and views read (the
 * name, whether it failed or was refused, a command's text and a result's first lines, a page tool's
 * result), not a file's contents, which the reply's parts already carry.
 */
export function reportOf(result: ChatToolResult): ChatToolResult {
  if (!result.name.startsWith('sandbox__')) return result;
  const input = result.input as { command?: unknown } | null;
  return {
    ...result,
    input: typeof input?.command === 'string' ? { command: input.command.slice(0, 500) } : {},
    output:
      typeof result.output === 'string'
        ? result.output.slice(0, REPORTED_OUTPUT_CHARS)
        : result.output !== null && typeof result.output === 'object' && 'error' in result.output
        ? {
            error: String((result.output as { error: unknown }).error).slice(
              0,
              REPORTED_OUTPUT_CHARS
            ),
          }
        : null,
  };
}

/**
 * A page card's offer id: unique per offer, not per tool set. The runner opens tools again for the
 * same run mid-reply (`reopenTools`), and a recovered run opens them in another process, so a
 * counter would name a later offer as an earlier one and the page would show that one's card.
 */
function offerId(runId: string, kind: 'cover' | 'feedback'): string {
  return `${runId}-${kind}-${randomUUID()}`;
}

/** Enough of a sandbox result for the page's gate: `exit_code:` and `render:` come first. */
const REPORTED_OUTPUT_CHARS = 200;

/**
 * The tools the page offers the assistant that the runner offers too, under the same names; the
 * preview's are the runner's own (`RunnerPreview`), which drive the tunnel themselves.
 */
const RUNNER_PAGE_TOOLS = [
  CREATE_APP,
  USE_OPEN_APP,
  SET_CHECKLIST,
  REPORT_READY,
  // Offers the user the page's Submit for review button; the page, not the runner, submits.
  SUBMIT_FOR_REVIEW,
  'start_preview',
  'stop_preview',
  // The open app's moderator review and user feedback, read by civitai as the run's user; and the
  // offer to change a feedback item's status, which the page's card, not the runner, carries out.
  ...APP_FEEDBACK_TOOLS,
  // Offers a store cover; the page's card makes it.
  GENERATE_APP_COVER,
  // What the open app did while it ran (`app_activity`), read by civitai as the run's user.
  ...RUNNER_ACTIVITY_TOOLS,
  // App hibernate: offered only while civitai lists the user's sleeping apps (the flag on).
  LIST_APPS,
  WAKE_APP,
] as const;

export interface AppAssistantToolsOptions {
  /** The hosted sandbox service's base URL (civitai's `APP_ASSISTANT_SANDBOX_URL`). */
  sandboxUrl: string;
  /** Tokens for one run, minted from its grant: `sandbox` for the sandbox service and its MCP server. */
  tokens(runId: string): TokenSource;
  /**
   * civitai's dev-tunnel endpoints with one run's grant (`CivitaiDevTunnels.forRun`): the live
   * preview. Unset, `start_preview` says the preview is not set up here.
   */
  devTunnels?(runId: string): DevTunnels;
  /**
   * `generate_app_cover` for one run: civitai's listing read with its grant (`CivitaiCovers.forRun`)
   * and the price on its `chat` token (`runnerCoverEstimator`). Unset, the tool says covers are not
   * set up.
   */
  covers?(runId: string): { listings: CoverListings; estimator: CoverEstimator };
  /**
   * civitai's app-feedback reads with one run's grant (`CivitaiAppFeedback.forRun`). Unset, the
   * feedback tools say they cannot read it here.
   */
  appFeedback?(runId: string, signal: AbortSignal): AppFeedbackSource;
  /**
   * civitai's app-activity read with one run's grant (`CivitaiAppActivity.forRun`). Unset,
   * `app_activity` says it cannot read it here.
   */
  appActivity?(runId: string, signal: AbortSignal): ReturnType<CivitaiAppActivity['forRun']>;
  /**
   * civitai's source-repo save with one run's grant (`CivitaiSourceSaves.forRun`): told the open
   * app after the assistant changed its files, once the reply pauses and when the run ends. Unset,
   * nothing is saved.
   */
  sourceSaves?(runId: string): (app: string) => Promise<void>;
  /**
   * App hibernate: civitai's sleeping-app reads with one run's grant (`CivitaiSleepingApps.forRun`).
   * Unset, or listing `null` (the `app-hibernate` flag off for the user), the reply has no
   * `list_apps` or `wake_app` and `create_app` is as before.
   */
  sleepingApps?(runId: string, signal: AbortSignal): RunSleepingApps;
  log: Logger;
  fetch?: typeof fetch;
  wakeTimeoutMs?: number;
  wakePollMs?: number;
  /** How often a live run keeps its preview alive (`PREVIEW_KEEPALIVE_MS` unless set; tests). */
  previewKeepaliveMs?: number;
  /** How long a reply's start waits for the app's `package.json` (`SDK_PIN_READ_TIMEOUT_MS`; tests). */
  sdkPinReadTimeoutMs?: number;
  /** The `@civitai/sdk` upgrade's budget before it is rolled back (`SDK_UPGRADE_TIMEOUT_MS`; tests). */
  sdkUpgradeTimeoutMs?: number;
  /** The fetch `read_docs` reads Civitai's developer docs with (the global one unless set; tests). */
  docsFetch?: typeof fetch;
  /** How long one `read_docs` read may take (`DOCS_TIMEOUT_MS` unless set; tests). */
  docsTimeoutMs?: number;
}

/** No dev-tunnel endpoints configured: every start is refused as not set up. */
const unconfiguredTunnels: DevTunnels = {
  start: async () => {
    throw new DevTunnelError('The live preview is not set up here.', 503, 'not_configured');
  },
  keepalive: async () => undefined,
  stop: async () => undefined,
};

/**
 * App Assistant's tools on the server runner: the open app's sandbox MCP tools, `create_app`,
 * `set_checklist` and `report_ready`, behind App Assistant's own gate (the per-reply call cap and
 * `report_ready`'s checks, from `@civitai/app-assistant`, the same code the page runs), and read-only
 * subagents when civitai's grant says the viewer has them, the live preview (`start_preview`,
 * `stop_preview`), which civitai opens for the run and the runner connects the sandbox to, and the
 * open app's feedback (`get_review_feedback`, `get_user_feedback`, `set_feedback_status`), which
 * civitai reads as the run's user and whose status changes only the page's card makes.
 */
export class AppAssistantTools implements ToolProvider {
  readonly #options: AppAssistantToolsOptions;
  /** Which conversations' apps had their `@civitai/sdk` upgrade tried: shared by every run. */
  readonly #sdkUpgrades: SdkUpgrades;

  constructor(options: AppAssistantToolsOptions) {
    this.#options = options;
    this.#sdkUpgrades = new SdkUpgrades({
      ...(options.sdkPinReadTimeoutMs !== undefined
        ? { readTimeoutMs: options.sdkPinReadTimeoutMs }
        : {}),
      ...(options.sdkUpgradeTimeoutMs !== undefined
        ? { upgradeTimeoutMs: options.sdkUpgradeTimeoutMs }
        : {}),
    });
  }

  async open(context: ToolContext): Promise<OpenTools> {
    const { runId, conversationId, signal } = context;
    const { sandboxUrl, log } = this.#options;
    const tokens = this.#options.tokens(runId);
    const sandboxToken = (fresh = false) => tokens('sandbox', { fresh, signal });
    const client = createSandboxClient({
      baseUrl: sandboxUrl,
      getToken: ({ refresh } = {}) => sandboxToken(refresh),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
    });
    // App hibernate: read beside the kept apps; `null` means the feature is off for this reply.
    const sleepingSource = this.#options.sleepingApps?.(runId, signal) ?? null;
    const sleepingRead = sleepingSource?.list().catch(() => null) ?? Promise.resolve(null);
    let sleeping: SleepingApp[] | null = null;
    /**
     * Every start of an app on the runner (a reply's start, create_app's resume): the one rule
     * (`startOrWakeApp`). A listed app is resumed with a plain open, its record or not; an app put to
     * sleep since is woken, never made new and empty. Records come from the reply's ONE read above:
     * a start never reads them again, so it never counts against civitai's list rate limit, and an
     * unread list (`null`) is "no record".
     */
    const openOrWake = (app: string): Promise<{ sandbox: Sandbox; created: boolean }> => {
      const records = sleepingSource ? sleeping : null;
      if (!sleepingSource || !records) return openApp(client, app);
      return startOrWakeApp(
        app,
        (apps ?? []).some((s) => s.app === app),
        {
          open: (key) => openApp(client, key),
          remove: (name) => client.remove(name),
          wake: (key) => wakeSleepingApp(client, key, (k) => sleepingSource.wakeSeed(k)),
          hasRecord: (key) => records.some((s) => s.app === key),
        }
      );
    };
    const newSandbox = (endReply?: (message: string) => void) =>
      new AppSandbox({
        open: openOrWake,
        client,
        baseUrl: sandboxUrl,
        // Not ended by a Stop (the mint has its own bound): a Stop does not cut short an upgrade of
        // the app's packages, which must still finish or roll back (`SdkUpgrades`).
        token: () => tokens('sandbox'),
        signal,
        log,
        runId,
        ...(endReply ? { endReply } : {}),
        ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
        ...(this.#options.wakeTimeoutMs !== undefined
          ? { wakeTimeoutMs: this.#options.wakeTimeoutMs }
          : {}),
        ...(this.#options.wakePollMs !== undefined ? { wakePollMs: this.#options.wakePollMs } : {}),
      });
    const sandbox = newSandbox(context.endReply);

    let preview: RunnerPreview | undefined;
    let apps: Sandbox[] | undefined;
    try {
      apps = await client.list();
    } catch (error) {
      // civitai refused the user (a ban, consent revoked): the reply ends with that, as at a model call.
      if (error instanceof MintRefusedError && error.code !== 'unavailable') throw error;
      log.warn({ err: (error as Error)?.name, runId }, 'listing the user’s apps failed');
    }
    sleeping = await sleepingRead;
    try {
      // Built again mid-reply (`reopenTools`, `rebuild`): the app this reply made or chose, which the
      // page may not have opened yet. Otherwise, a reply's start, Retry and Continue included, the app
      // open in the page: what the user has open wins.
      const pageState = readPageState(context.page);
      const pageApp =
        (context.rebuild ? appChosenIn(toolResultsOf(context.history?.current ?? [])) : null) ??
        pageState.app;
      await sandbox.open(pageApp, apps ?? []);
      const sandboxTools = await sandbox.tools();

      const appTools = createAppTools({
        apps: () => apps,
        current: () => sandbox.active,
        // Ready once the app it made runs with its tools, as the rebuild will open it (`appChosenIn`):
        // a sandbox of its own opens it (waking it, and waiting as long as a reply's start does) and
        // lists its tools. Not running in time, or listing none, it is not ready.
        toolsReady: (app) => sandboxReady(newSandbox(), client, app, log, runId),
        open: async (app) => {
          const before = sandbox.active?.name ?? null;
          const opened = await openOrWake(app);
          sandbox.opened(opened.sandbox);
          apps = [...(apps ?? []).filter((s) => s.name !== opened.sandbox.name), opened.sandbox];
          // What was verified belongs to the sandbox it was verified in, and so does a checklist,
          // as the page resets its gate when another app opens.
          if (opened.sandbox.name !== before) core.reset();
          return opened;
        },
        ...(sleepingSource && sleeping
          ? {
              sleeping: () => sleeping ?? undefined,
              wake: async (app: string) => {
                const before = sandbox.active?.name ?? null;
                const woken = await wakeSleepingApp(client, app, (key) =>
                  sleepingSource.wakeSeed(key)
                );
                sandbox.opened(woken.sandbox);
                apps = [
                  ...(apps ?? []).filter((s) => s.name !== woken.sandbox.name),
                  woken.sandbox,
                ];
                sleeping = (sleeping ?? []).filter((s) => s.app !== app);
                if (woken.sandbox.name !== before) core.reset();
                return woken;
              },
            }
          : {}),
      });
      // The app's source repo commits each spell of changes (one per pause, and one at the end).
      const saveSource = this.#options.sourceSaves?.(runId);
      const sourceSaves = saveSource ? createSourceSaveScheduler({ save: saveSource }) : null;
      const core = createGateCore({
        refuse: (name) =>
          // Features are planned for an app, so not before one exists.
          name === SET_CHECKLIST && !sandbox.active ? NO_APP_REFUSAL : appTools.refusal(name),
        onReply: appTools.newReply,
        // Each checklist says which app it was for, so a later reply carries only this app's.
        checklistApp: () => sandbox.active?.app ?? null,
        // A chat changes only the app it made or chose: a new chat never builds over the open one.
        openApp: () => sandbox.active?.app ?? null,
        // civitai refuses a submission whose sensitive scopes have no justification.
        unjustifiedScopes: () => unjustifiedManifestScopes(sandbox, signal),
        // A sandbox with run_checks is told to run it; the others, npm test and tsc.
        sandboxFeatures: () => sandbox.features,
        ...(sourceSaves ? { onAppChanged: (app: string) => sourceSaves.changed(app) } : {}),
      });
      core.restore({
        conversationId,
        earlier: toolResultsOf(context.history?.earlier ?? []),
        current: toolResultsOf(context.history?.current ?? []),
        app: sandbox.active?.app ?? null,
      });

      preview = new RunnerPreview({
        sandbox,
        tunnels: this.#options.devTunnels?.(runId) ?? unconfiguredTunnels,
        log,
        runId,
        ...(this.#options.previewKeepaliveMs !== undefined
          ? { keepaliveMs: this.#options.previewKeepaliveMs }
          : {}),
      });
      if (this.#options.devTunnels) {
        openPreviewAfterDevServer(sandboxTools, preview, context);
        // The app's preview stays up while the run works, whoever opened it (this run, the page's
        // Restart preview): a hidden tab sends the tunnel no activity of its own.
        preview.keepWhileRunning();
      }
      // An app on an older @civitai/sdk than the host's is upgraded by the runner itself, before the
      // assistant's first step, so none of its calls runs meanwhile (never throws; rolls back on failure).
      const livePreview = preview;
      const upgradeSdk = () =>
        this.#sdkUpgrades.upgrade({
          sandbox,
          // Not listed: its MCP server is not answering (no tools at all), or has no such tool.
          hasTool: (name) => `sandbox__${name}` in sandboxTools,
          startDevServer: () => livePreview.startDevServer(),
          // The install changed files: both gates hear of it as of any command, so checks run again.
          report: (result) => {
            core.onToolResult(result);
            context.report?.(reportOf(result));
          },
          conversationId,
          runId,
          log,
          signal,
        });
      const sdkUpgrade = await upgradeSdk();
      // The store cover: the page's own tool (`createCoverArt`).
      const covers = this.#options.covers?.(runId);
      const coverTools: Record<string, ChatTool> = covers
        ? runnerCoverTools({
            currentApp: () => sandbox.active?.app ?? null,
            ...covers,
            nextId: () => offerId(runId, 'cover'),
            signal,
          })
        : unconfiguredCoverTools();
      const feedback = createFeedbackTools({
        current: () => sandbox.active?.app ?? null,
        source: this.#options.appFeedback?.(runId, signal) ?? unconfiguredFeedbackSource,
        nextId: () => offerId(runId, 'feedback'),
      });
      const pageTools: Record<string, ChatTool> = {
        ...appTools.tools,
        ...feedback.tools,
        ...core.tools,
        [SUBMIT_FOR_REVIEW]: upgradeBeforeSubmit(core.tools[SUBMIT_FOR_REVIEW], upgradeSdk),
        ...preview.tools(),
        ...coverTools,
        ...runnerActivityTools({
          // The preview's block id, not the app's key: the two differ when the key's was taken.
          currentApp: () => livePreview.previewBlockId(signal),
          source: this.#options.appActivity?.(runId, signal),
        }),
      };
      // As `<civitai-chat>` offers a page's own tools (the chat's `hostToolSet`): the same
      // descriptions and the same failure note. No chat files reach them on the runner.
      const page = hostToolSet(runnerPageTools(pageTools), sandboxTools, {
        conversationId,
        findAttachment: () => undefined,
        resolveArgs: async (args) => args,
      });
      // Civitai's developer docs, which the sandbox cannot reach: the runner reads them itself. Not a
      // page tool (`hostTools`): the page has its own fetch_page. One per reply, so its cache is too.
      const docs = hostToolSet(
        {
          [READ_DOCS]: createDocsTool({
            ...(this.#options.docsFetch ? { fetch: this.#options.docsFetch } : {}),
            ...(this.#options.docsTimeoutMs !== undefined
              ? { timeoutMs: this.#options.docsTimeoutMs }
              : {}),
          }),
        },
        sandboxTools,
        { conversationId, findAttachment: () => undefined, resolveArgs: async (args) => args }
      );
      const tools: ToolSet = { ...sandboxTools, ...page, ...docs };
      // Aborts when the gate ends the reply on one of its own calls: its subagents stop with it.
      const replyEnded = new AbortController();
      const gate: GateDeps = {
        conversationId,
        gate: core.beforeToolCall,
        onResult: (result) => {
          core.onToolResult(result);
          context.report?.(reportOf(result));
        },
        reply: nextReply(),
        onEnded: () => replyEnded.abort(),
      };

      const subagents = context.subagents === true;
      const resolved = subagents ? resolveSubagents(appAssistantSubagents('remote')) : undefined;
      const model = context.model;
      if (resolved && model && subagentToolNames(resolved.tools, tools).length > 0) {
        tools[DISPATCH_AGENT] = dispatchAgentTool({
          options: resolved,
          tools: { ...tools },
          // Its own gate, so a stop on a subagent's call ends only that subagent.
          gate: (childTools, subagent) =>
            gateToolSet(childTools, { ...gate, subagent, onEnded: undefined }),
          ended: replyEnded.signal,
          model,
          maxOutputTokens: () => context.maxOutputTokens ?? outputTokenCap(undefined),
          progress: new ReportingTracker(context.subagentProgress),
        });
      }

      return {
        tools: gateToolSet(tools, gate),
        // The run's end stops keeping its preview alive; the preview itself idles out later.
        close: async () => {
          preview?.close();
          // The reply's last changes: civitai reads them from the sandbox service itself (not over
          // this run's MCP connection), so the end of the run waits for it only so long.
          if (sourceSaves)
            await Promise.race([
              sourceSaves.flush(),
              new Promise((resolve) => setTimeout(resolve, SOURCE_SAVE_FLUSH_WAIT_MS).unref?.()),
            ]);
          await sandbox.close();
        },
        // The runner's variant names only tools it has (no web or guide tool, no tunnel).
        // …and the newer sandbox tools' rules only when the open app's sandbox lists them.
        rules: assistantSystemPrompt('remote', subagents, sandbox.features),
        instructions: [
          buildAssistantInstructions({
            sandbox: sandbox.active,
            apps: (apps ?? []).map((s) => s.app),
            // civitai judges the dev-tunnel gates at `start_preview`; a refusal says to go without it.
            canPreview: true,
            previewHost: null,
            runner: 'remote',
            ...(sleeping
              ? {
                  sleeping: sleepingNotLive(apps ?? [], sleeping).map((s) => s.app),
                  woken: pageState.woken === true && pageState.app === sandbox.active?.app,
                }
              : {}),
          }),
          ...(sdkUpgrade.kind === 'upgraded' ? [sdkUpgrade.instructions] : []),
        ].join('\n\n'),
        hostTools: Object.keys(page),
      };
    } catch (error) {
      preview?.close();
      await sandbox.close();
      throw error;
    }
  }
}

/** How long a run's end waits for its last source-repo save (which carries on after it). */
export const SOURCE_SAVE_FLUSH_WAIT_MS = 15_000;

/**
 * The sandbox tools whose success opens the preview by itself: a start, and a restart (a later
 * reply finds the dev server still running, so it restarts rather than starts it).
 */
const DEV_SERVER_STARTS = ['sandbox__dev_server_start', 'sandbox__dev_server_restart'] as const;

/** What the assistant reads after the dev server's own answer when the preview opened by itself. */
export const AUTO_PREVIEW_SHOWN =
  'The live preview opened by itself: the user now sees this dev server beside the chat. To see what they see, call sandbox__preview_check. Do not call start_preview for it.';
/** …and when it could not open; the dev server still started. */
export const autoPreviewFailed = (why: string) =>
  `The live preview did not open by itself: ${why} The dev server did start.`;

/**
 * Makes a successful `sandbox__dev_server_start` (or `_restart`) open the preview (once per app in the run, see
 * `RunnerPreview.openAfterDevServer`): the page is told as it is of a `start_preview` call (a
 * `tool-reported` result carrying only the block and the host), and the assistant reads what
 * happened after the dev server's own answer. A refusal never fails the dev server's start.
 */
function openPreviewAfterDevServer(
  sandboxTools: ToolSet,
  preview: RunnerPreview,
  context: ToolContext
): void {
  for (const name of DEV_SERVER_STARTS) wrapDevServerStart(sandboxTools, name, preview, context);
}

function wrapDevServerStart(
  sandboxTools: ToolSet,
  name: string,
  preview: RunnerPreview,
  context: ToolContext
): void {
  const tool = sandboxTools[name];
  const execute = tool?.execute;
  if (!tool || !execute) return;
  sandboxTools[name] = {
    ...tool,
    execute: async (input: unknown, options: { abortSignal?: AbortSignal }) => {
      const output = await (execute as (input: unknown, options: unknown) => Promise<unknown>)(
        input,
        options
      );
      if (typeof output !== 'string' || !devServerRuns(output)) return output;
      // A restart with no command runs the previous one: its status names the command it ran.
      const auto: AutoPreview | null = await preview.openAfterDevServer(
        { command: commandOf(input) ?? commandOf(parseJson(output)) },
        options.abortSignal
      );
      if (!auto) return output;
      if ('error' in auto) return `${output}\n\n${autoPreviewFailed(auto.error)}`;
      context.report?.({ name: START_PREVIEW, input: {}, output: auto.shown, isError: false });
      return `${output}\n\n${AUTO_PREVIEW_SHOWN}`;
    },
  } as typeof tool;
}

/** The `command` field of a dev server call's input, or of the status it answered. */
function commandOf(value: unknown): string | undefined {
  const command = (value as { command?: unknown } | null)?.command;
  return typeof command === 'string' ? command : undefined;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A dev server start's status says the server runs (an unreadable answer counts as yes). */
function devServerRuns(output: string): boolean {
  try {
    return (JSON.parse(output) as { running?: unknown } | null)?.running !== false;
  } catch {
    return true;
  }
}

/** Subagents' progress, told to the page as the session's tracker would show it. */
class ReportingTracker extends SubagentTracker {
  readonly #report: ToolContext['subagentProgress'];

  constructor(report: ToolContext['subagentProgress']) {
    super();
    this.#report = report;
  }

  override set(id: string, progress: SubagentProgress | undefined): void {
    super.set(id, progress);
    this.#report?.(id, progress ?? null);
  }
}

/**
 * The app the reply's own calls chose so far: the last one the gate counts as chosen (`chosenAppOf`:
 * a `create_app` that made a new app, or a `use_open_app`; never a subagent's, nor one that found an
 * app the user already had), as the reply's tools are built again mid-reply; `null` when none did.
 */
export function appChosenIn(results: readonly ToolResult[]): string | null {
  for (const result of [...results].reverse()) {
    const app = chosenAppOf(result);
    if (app) return app;
  }
  return null;
}

/**
 * Whether `app` runs with its tools now: `probe` (a sandbox of its own) opens it among the user's apps,
 * waking it and waiting as a reply's start does, and lists its tools. `false` when the list fails, the
 * app is not in it, it does not run in time, or it lists no tools. The probe's connection is closed.
 */
export async function sandboxReady(
  probe: AppSandbox,
  client: { list(): Promise<Sandbox[]> },
  app: string,
  log: Logger,
  runId: string
): Promise<boolean> {
  try {
    await probe.open(app, await client.list());
    if (probe.active?.app !== app || probe.active.state !== 'running') return false;
    return Object.keys(await probe.tools()).length > 0;
  } catch (error) {
    log.warn({ err: (error as Error)?.name, runId }, 'checking the new app runs failed');
    return false;
  } finally {
    await probe.close().catch(() => undefined);
  }
}

/** The page tools offered only with app hibernate on (civitai lists the user's sleeping apps). */
const OPTIONAL_PAGE_TOOLS: ReadonlySet<string> = new Set([LIST_APPS, WAKE_APP]);

/**
 * `RUNNER_PAGE_TOOLS` out of the reply's page tools. Only the hibernate tools may be absent; any
 * other one missing is a wiring bug, and it throws rather than offer a reply without it.
 */
export function runnerPageTools<T>(pageTools: Record<string, T>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const name of RUNNER_PAGE_TOOLS) {
    const tool = pageTools[name];
    if (tool) out[name] = tool;
    else if (!OPTIONAL_PAGE_TOOLS.has(name)) throw new Error(`page tool ${name} is missing`);
  }
  return out;
}
