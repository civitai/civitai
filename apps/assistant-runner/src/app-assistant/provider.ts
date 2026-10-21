import {
  NO_APP_REFUSAL,
  SET_CHECKLIST,
  appAssistantSubagents,
  assistantSystemPrompt,
  buildAssistantInstructions,
  createAppTools,
  createGateCore,
  createSandboxClient,
  openApp,
  type AssistantTool,
  type Sandbox,
} from '@civitai/app-assistant';
import {
  DISPATCH_AGENT,
  SubagentTracker,
  dispatchAgentTool,
  gateToolSet,
  nextReply,
  outputTokenCap,
  resolveSubagents,
  subagentToolNames,
  type GateDeps,
  type SubagentProgress,
} from '@civitai/components-chat/core';
import type { ChatToolResult, RunPageState } from '@civitai/components-chat/runner-protocol';
import { dynamicTool, jsonSchema, type ToolSet } from 'ai';

import type { Logger, OpenTools, ToolContext, ToolProvider } from '../interfaces';
import { MintRefusedError, type TokenSource } from '../minter';
import { toolResultsOf } from './history';
import { AppSandbox } from './sandbox';

/**
 * What App Assistant's page says about itself as a reply starts (`remoteRunner.pageState`): the key
 * of the app open in it, or `null`. Only that, and never trusted: the runner looks the key up among
 * the user's own sandboxes with the user's own token, so a key the user has no sandbox for (or any
 * other value) opens nothing.
 */
export interface AppAssistantPageState {
  app: string | null;
}

/** The page's state as the runner reads it; anything but a string is no app open. */
export function readPageState(page: RunPageState | undefined): AppAssistantPageState {
  const app = page?.app;
  return { app: typeof app === 'string' && app.length > 0 && app.length <= 200 ? app : null };
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

/** Enough of a sandbox result for the page's gate: `exit_code:` and `render:` come first. */
const REPORTED_OUTPUT_CHARS = 200;

/** The tools the page offers the assistant that the runner offers too; the preview tools stay page-only. */
const RUNNER_PAGE_TOOLS = ['create_app', 'set_checklist', 'report_ready'] as const;

// As `<civitai-chat>`'s `hostToolSet` wraps a page's tools, so they read the same to the assistant.
const MEDIA_NOTE = ' Pass attachment ids (like up1-1 or gen2-1-1) for files from this chat.';
// The chat's note for a failed page tool (`tools/host`), not the one for a server's tool.
const PAGE_TOOL_FAILED_NOTE =
  'This did not work. Tell the user in plain words; do not retry it this turn.';

export interface AppAssistantToolsOptions {
  /** The hosted sandbox service's base URL (civitai's `APP_ASSISTANT_SANDBOX_URL`). */
  sandboxUrl: string;
  /** Tokens for one run, minted from its grant: `sandbox` for the sandbox service and its MCP server. */
  tokens(runId: string): TokenSource;
  log: Logger;
  fetch?: typeof fetch;
  wakeTimeoutMs?: number;
  wakePollMs?: number;
}

/**
 * App Assistant's tools on the server runner: the open app's sandbox MCP tools, `create_app`,
 * `set_checklist` and `report_ready`, behind App Assistant's own gate (the per-reply call cap and
 * `report_ready`'s checks, from `@civitai/app-assistant`, the same code the page runs), and read-only
 * subagents when civitai's grant says the viewer has them. The live preview (`start_preview`,
 * `stop_preview`) needs the page and is not offered: the reply's instructions say so.
 */
export class AppAssistantTools implements ToolProvider {
  readonly #options: AppAssistantToolsOptions;

  constructor(options: AppAssistantToolsOptions) {
    this.#options = options;
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
    const sandbox = new AppSandbox({
      client,
      baseUrl: sandboxUrl,
      token: () => sandboxToken(),
      signal,
      log,
      runId,
      ...(context.endReply ? { endReply: context.endReply } : {}),
      ...(this.#options.fetch ? { fetch: this.#options.fetch } : {}),
      ...(this.#options.wakeTimeoutMs !== undefined
        ? { wakeTimeoutMs: this.#options.wakeTimeoutMs }
        : {}),
      ...(this.#options.wakePollMs !== undefined ? { wakePollMs: this.#options.wakePollMs } : {}),
    });

    let apps: Sandbox[] | undefined;
    try {
      apps = await client.list();
    } catch (error) {
      // civitai refused the user (a ban, consent revoked): the reply ends with that, as at a model call.
      if (error instanceof MintRefusedError && error.code !== 'unavailable') throw error;
      log.warn({ err: (error as Error)?.name, runId }, 'listing the user’s apps failed');
    }
    try {
      const pageApp = readPageState(context.page).app;
      await sandbox.open(pageApp, apps ?? []);
      const sandboxTools = await sandbox.tools();

      const appTools = createAppTools({
        apps: () => apps,
        current: () => sandbox.active,
        open: async (app) => {
          const before = sandbox.active?.name ?? null;
          const opened = await openApp(client, app);
          sandbox.opened(opened.sandbox);
          apps = [...(apps ?? []).filter((s) => s.name !== opened.sandbox.name), opened.sandbox];
          // What was verified belongs to the sandbox it was verified in, and so does a checklist,
          // as the page resets its gate when another app opens.
          if (opened.sandbox.name !== before) core.reset();
          return opened;
        },
      });
      const core = createGateCore({
        refuse: (name) =>
          // Features are planned for an app, so not before one exists.
          name === SET_CHECKLIST && !sandbox.active ? NO_APP_REFUSAL : appTools.refusal(name),
        onReply: appTools.newReply,
        currentApp: () => sandbox.active?.name ?? null,
        // Each checklist says which app it was for, so a later reply carries only this app's.
        checklistApp: () => sandbox.active?.app ?? null,
      });
      core.restore({
        conversationId,
        earlier: toolResultsOf(context.history?.earlier ?? []),
        current: toolResultsOf(context.history?.current ?? []),
        app: sandbox.active?.app ?? null,
      });

      const page = pageToolSet({ ...appTools.tools, ...core.tools }, signal);
      const tools: ToolSet = { ...sandboxTools, ...page };
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
        close: () => sandbox.close(),
        // The runner's variant names only tools it has (no web or guide tool, no tunnel).
        rules: assistantSystemPrompt('remote', subagents),
        instructions: buildAssistantInstructions({
          sandbox: sandbox.active,
          apps: (apps ?? []).map((s) => s.app),
          canPreview: false,
          previewHost: null,
          runner: 'remote',
        }),
        hostTools: Object.keys(page),
      };
    } catch (error) {
      await sandbox.close();
      throw error;
    }
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

/** The page tools the runner offers, as `<civitai-chat>` offers a page's tools to the assistant. */
function pageToolSet(tools: Record<string, AssistantTool>, signal: AbortSignal): ToolSet {
  const set: ToolSet = {};
  for (const name of RUNNER_PAGE_TOOLS) {
    const pageTool = tools[name];
    if (!pageTool) continue;
    set[name] = dynamicTool({
      description: `${pageTool.description}${MEDIA_NOTE}`,
      inputSchema: jsonSchema({ type: 'object', ...pageTool.inputSchema }),
      execute: async (input) => {
        if (signal.aborted) throw new Error('The reply was stopped before this call ran.');
        try {
          const result = await pageTool.execute((input ?? {}) as Record<string, unknown>);
          return result === undefined ? { ok: true } : result;
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error),
            note: PAGE_TOOL_FAILED_NOTE,
          };
        }
      },
    });
  }
  return set;
}
