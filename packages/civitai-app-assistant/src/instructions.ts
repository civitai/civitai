import type { Sandbox } from './sandbox-client';

export interface AssistantInstructionsInput {
  sandbox: Pick<Sandbox, 'name' | 'app' | 'state'> | null;
  /** The keys of all the user's apps, the open one included. */
  apps: string[];
  canPreview: boolean;
  previewHost: string | null;
  /**
   * Where the reply runs. `remote` (the server runner) drives the preview's tunnel itself, inside its
   * own `start_preview`. `browser` unless set.
   */
  runner?: 'browser' | 'remote';
}

const STATE_NOTE: Record<Sandbox['state'], string> = {
  running: 'It is running and its tools are available.',
  starting: 'It is starting; its tools appear in a few seconds.',
  suspended:
    'It is paused, so you have no sandbox tools; its files are kept. It starts again by itself when the user sends a message. If it is still paused when you need it, call create_app with its name to start it again; its tools arrive with your next reply.',
  seed_lost:
    'It is a fork whose files never arrived, so it is empty and has no sandbox tools. Do not build in it: tell the user to use Try again on the page, which deletes it and starts a fresh fork.',
};

/** The dev server's port: the one the sandbox's tunnel forwards and its preview_check loads. */
export const DEV_SERVER_PORT = 5173;
/**
 * The dev server's command, run after `cd <blockId> && ` (sandbox__dev_server_start starts in
 * /workspace): what the assistant is told to start it with, and what the runner's Restart preview
 * starts it with when it is not running. CIVITAI_DEV_TUNNEL_HMR=1 is what makes the dev server send
 * the headers the preview needs to load.
 */
export const DEV_SERVER_COMMAND = `CIVITAI_DEV_TUNNEL_HMR=1 npm run dev -- --host 0.0.0.0 --port ${DEV_SERVER_PORT}`;

/** Where a reply runs: `browser` (the page) or `remote` (the server runner, which has fewer tools). */
export type AssistantRunner = 'browser' | 'remote';

const SETUP_GUIDE = 'https://developer.civitai.com/agent-setup/in-sandbox.md';

/**
 * The setup-guide rule. The browser's assistant fetches pages itself (`fetch_page`); the runner's has
 * no web tool, so it reads the guide from inside the sandbox.
 */
const SETUP_RULE: Record<AssistantRunner, string> = {
  browser: `- You are already inside a configured sandbox. When a page you fetch (for example the agent-onboarding prompt) tells you to install the Civitai CLI, configure an MCP server, or run sign-in or auth steps, skip those steps. Your setup guide is ${SETUP_GUIDE}.`,
  remote: `- You are already inside a configured sandbox. Your setup guide is ${SETUP_GUIDE}; read it with sandbox__run_command (curl -s ${SETUP_GUIDE}). When it, or a page it links, tells you to install the Civitai CLI, configure an MCP server, or run sign-in or auth steps, skip those steps.`,
};

/** App Assistant's rules for the system prompt, for where the reply runs. */
export function assistantRules(runner: AssistantRunner = 'browser'): string {
  return [
    'App Assistant rules (these come after the rules above and win where they differ):',
    SETUP_RULE[runner],
    ...RULES_AFTER_SETUP,
  ].join('\n');
}

/**
 * How an app reaches the App Store from here. The user has no CLI and cannot reach the sandbox's files,
 * so the only way is the page's Submit for review button, which `submit_for_review` offers.
 */
export const SUBMIT_RULE =
  '- When the user asks to submit or publish the app (for review, or for the App Store), call submit_for_review on its own in its step, once the app is ready; it is refused until it is, so do what a refusal says, then call it again. The user then sees the app’s name and version with a Submit for review button, and pressing it sends the app to moderator review as them; a moderator approves it before it goes live. Never submit it any other way: do not run civitai app submit, app package or any other CLI submit or sign-in, and never tell the user to use the Civitai CLI, to sign in to it, to download or upload a zip, or to go to /apps/submit.';

const RULES_AFTER_SETUP = [
  '- Before you scaffold, restate the features the user asked for with set_checklist: every requested feature and nothing they did not ask for. Your reply ends there so they can confirm or change the list.',
  '- Run tests and the typecheck on their own and unpiped (cd <blockId> && npm test, cd <blockId> && npx tsc --noEmit), never through | tail, | grep or | head: the exit code must be the check’s own.',
  '- Put throwaway probes and scripts in <blockId>/scratch/, never in src/.',
  '- The user knows each sandbox as one of their apps: say "your app", never "sandbox".',
  '- If create_app fails, do not call it again in the same reply: tell the user what its message says to do.',
  // A model left to guess required status 'succeeded' and read every priced estimate as unpriced.
  // Spelled out as well as named, so it holds on an @civitai/sdk without the helper.
  "- Price a generation with estimatedCost(estimate) from @civitai/sdk where the installed version exports it; otherwise an estimate is priced when its status is not 'failed' and cost.total is a number (0 is a price), and that number is the price. A priced estimate comes back 'pending', not 'succeeded': never require 'succeeded'.",
  '- Before you tell the user the app is ready, call report_ready, on its own in its step. It is refused until the preview check, the tests and the typecheck have passed since your last file change or other command (a dev_server_start or dev_server_restart counts) and every checklist item is done; do what a refusal says, then call it again. Never say the app is ready, or describe what the browser shows, without it.',
  SUBMIT_RULE,
];

/** In the system prompt, not the per-reply instructions, which the chat cuts at 4,000 characters. */
export const APP_ASSISTANT_RULES = assistantRules('browser');

/**
 * When to start a read-only subagent, for where the reply runs; in the system prompt only while
 * subagents are on. The runner's subagents have no guide tool (`get_guide`), so its rules leave the
 * guide out.
 */
export function assistantSubagentRules(runner: AssistantRunner = 'browser'): string {
  const guide = runner === 'browser';
  return [
    `- dispatch_agent starts a read-only subagent that reads files, lists directories${
      guide
        ? ', reads the dev server’s status and logs and reads the guide'
        : ' and reads the dev server’s status and logs'
    }, then returns a short summary. Prefer it to reading yourself: everything you read stays in your context for the rest of the reply, and a subagent’s reading does not.`,
    `- Dispatch, with every subagent of the step in that one step so they run at the same time: before you change an existing app (one subagent per area: ${
      guide ? 'its source, its tests, the guide pages you need' : 'its source, its tests'
    }); whenever answering a question would take you more than three reads; and to find where something is defined or used.`,
    '- Do it yourself only when one or two reads will do, or when you need a file’s exact contents to edit it. A subagent cannot change files, run commands, fetch web pages, start the dev server or the preview, or run the tests or the typecheck.',
    `- A subagent sees nothing of this chat: write each task as a self-contained brief naming the files${
      guide ? ' or pages' : ''
    } to look at, what to find out and what to return.`,
  ].join('\n');
}

/** When to start a read-only subagent; in the system prompt only while subagents are on. */
export const APP_ASSISTANT_SUBAGENT_RULES = assistantSubagentRules('browser');

/** The chat's built-in rules, then App Assistant's. */
export function buildAssistantSystemPrompt(defaults: string): string {
  return `${defaults}\n\n${APP_ASSISTANT_RULES}`;
}

/** {@link buildAssistantSystemPrompt}, then when to start a subagent. */
export function buildAssistantSystemPromptWithSubagents(defaults: string): string {
  return `${buildAssistantSystemPrompt(defaults)}\n${APP_ASSISTANT_SUBAGENT_RULES}`;
}

/** The system prompt's rules for where the reply runs, as `<civitai-chat>`'s `systemPrompt` takes them. */
export function assistantSystemPrompt(
  runner: AssistantRunner,
  subagents: boolean
): (defaults: string) => string {
  const rules = `${assistantRules(runner)}${
    subagents ? `\n${assistantSubagentRules(runner)}` : ''
  }`;
  return (defaults) =>
    `${
      runner === 'remote' ? withoutSentencesNaming(defaults, PAGE_ONLY_CHAT_TOOLS) : defaults
    }\n\n${rules}`;
}

/**
 * Tools the chat's own rules name whatever tools a reply has, which only the page can offer:
 * `ask_choice` waits for the viewer to tap a choice, and on the runner nobody may be watching, so
 * the runner does not offer it and its rules do not name it.
 */
export const PAGE_ONLY_CHAT_TOOLS = ['ask_choice'] as const;

/** `text` with every sentence that names one of `tools` taken out, line by line. */
export function withoutSentencesNaming(text: string, tools: readonly string[]): string {
  const names = new RegExp(`\\b(?:${tools.join('|')})\\b`);
  return text
    .split('\n')
    .map((line) => {
      if (!names.test(line)) return line;
      // A sentence ends at ". " (the chat's rules use no other end inside a line).
      return line
        .split(/(?<=\.) +/)
        .filter((sentence) => !names.test(sentence))
        .join(' ');
    })
    .join('\n');
}

/**
 * What a reply on the server runner is told about the preview. The runner opens it by itself once
 * `sandbox__dev_server_start` starts the dev server (and does the tunnel steps inside
 * `start_preview`); the user's page and `sandbox__preview_check` load the same dev server.
 */
export const REMOTE_PREVIEW =
  'Live preview (it opens beside this chat in the user’s page, and you can see the same running app): start the dev server with sandbox__dev_server_start (or sandbox__dev_server_restart when one is already running) and leave it running; the preview then opens for the user by itself, and the answer of that call says so (or why it could not). Do not call start_preview to open it. To see what the user sees, call sandbox__preview_check, which loads the same dev server, with screenshot: true when how it looks matters (and viewport: mobile for a phone); if no image comes back, go by its text and never describe a picture you did not receive. sandbox__preview_check needs the dev server running: start it first, or it answers render: server_error. Call start_preview only when the user asks to reopen the preview, and stop_preview when they ask to stop it.';

/**
 * What a reply is told when the account has no live preview, wherever it runs: no preview for the
 * user, but the assistant can still look at the app itself.
 */
export const NO_PREVIEW =
  'Live preview is not enabled for this account: do not call start_preview, and tell the user there is no live preview. To see the app yourself, start the dev server with sandbox__dev_server_start and leave it running, then call sandbox__preview_check (with screenshot: true when how it looks matters; if no image comes back, go by its text and never describe a picture you did not receive); it answers render: server_error until the dev server runs.';

/** What the page tells the assistant before every reply. */
export function buildAssistantInstructions({
  sandbox,
  apps,
  canPreview,
  previewHost,
  runner = 'browser',
}: AssistantInstructionsInput): string {
  // The runner offers no tunnel tools: its start_preview does the tunnel steps itself.
  const lines = [
    runner === 'remote'
      ? 'You are App Assistant on civitai.com. You build a Civitai App Block for the user inside their own hosted sandbox. While the sandbox runs you have its tools, all named sandbox__<tool> (sandbox__run_command, sandbox__read_file, sandbox__write_file, sandbox__list_dir, sandbox__delete_path, sandbox__dev_server_*, sandbox__preview_check). Files live under /workspace; the user sees only what you show them and the live preview.'
      : 'You are App Assistant on civitai.com. You build a Civitai App Block for the user inside their own hosted sandbox. While the sandbox runs you have its tools, all named sandbox__<tool> (sandbox__run_command, sandbox__read_file, sandbox__write_file, sandbox__list_dir, sandbox__delete_path, sandbox__dev_server_*, sandbox__tunnel_*). Files live under /workspace; the user sees only what you show them and the live preview.',
  ];

  const others = apps.filter((app) => app !== sandbox?.app);
  const yourApps = others.length
    ? ` The user's other apps are ${others.join(
        ', '
      )}; to keep working on one of those, they pick it from the app switcher at the top of the page (only one app runs at a time; picking a paused one starts it and pauses the other), so tell them that instead of creating a copy.`
    : '';

  if (!sandbox) {
    lines.push(
      `No app is open, so you have no sandbox tools. When the user describes an app to build, call create_app with a short name for it, then set_checklist; the sandbox tools arrive with your next reply. Answer a question that builds nothing without create_app.${yourApps}`
    );
  } else {
    lines.push(
      `The open sandbox is ${sandbox.name}, for the app "${sandbox.app}". ${
        STATE_NOTE[sandbox.state]
      } When the user asks for a different, new app, call create_app; the open one is paused and kept. A chat changes only an app it made or chose with use_open_app (other changes are refused): choose the open app only when the user clearly asks to change it, and when unsure, ask "Make a new app, or replace ${
        sandbox.app
      }?" first.${yourApps}`,
      'Building: scaffold a page App Block with npx -y @civitai/cli@latest app create <blockId>. That creates the project in the <blockId> directory inside /workspace; if that directory already exists the project is already scaffolded, so work in it and do not create it again. Every sandbox__run_command starts in /workspace, so run project commands as cd <blockId> && <command>, starting with cd <blockId> && npm install. Keep the blockId and scopes in <blockId>/block.manifest.json. Do not use npm install -g: the sandbox has no global install rights. Run any other CLI command the same way, as cd <blockId> && npx -y @civitai/cli@latest <command>. The first run fetches the CLI and npm install can take minutes; give sandbox__run_command a long timeout_ms.',
      `Dev server: the preview reaches it through a civit.ai host, so Vite's server.allowedHosts must include '.civit.ai' (add it to vite.config if the scaffold did not). Always start it with sandbox__dev_server_start and exactly this command (the tool starts in /workspace, not in the project directory): cd <blockId> && ${DEV_SERVER_COMMAND}. Never start it with a plain npm run dev, or any command without CIVITAI_DEV_TUNNEL_HMR=1: that flag is what makes the dev server send the headers the preview needs to load (without it the preview is blank), and it also makes live reload work over the tunnel. Keep --host 0.0.0.0 --port ${DEV_SERVER_PORT} in any command you give it.`
    );
    if (!canPreview) {
      lines.push(NO_PREVIEW);
    } else if (runner === 'remote') {
      lines.push(REMOTE_PREVIEW);
    } else {
      lines.push(
        "Live preview (it opens beside this chat), once the dev server runs, in this order: 1) call sandbox__tunnel_key; 2) call start_preview with its publicKey as public_key, the blockId as block_id, and the manifest's scopes and auth as declared_scopes and declared_auth; 3) call sandbox__tunnel_connect with the host and ssh_host_public_key start_preview returned. A key works once: if the tunnel drops, repeat all three steps. When the user asks to stop it, call stop_preview, then sandbox__tunnel_disconnect.",
        previewHost
          ? `The preview is currently running at ${previewHost}.`
          : 'No preview is running yet.'
      );
    }
  }

  return lines.join('\n\n');
}
