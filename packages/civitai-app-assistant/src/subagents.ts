import { SANDBOX_SERVER_ID } from './gate';

/**
 * The only tools a subagent gets, by exact name. An allowlist: a tool the sandbox or the orchestrator adds
 * later stays out until it is listed here. Each one only reads and costs nothing per call, so a subagent
 * never changes the app, what `report_ready` counts as checked (`sandbox__preview_check` sets that), or
 * the user's Buzz (`fetch_page` is billed per call).
 */
export const APP_ASSISTANT_SUBAGENT_TOOLS = [
  `${SANDBOX_SERVER_ID}__read_file`,
  `${SANDBOX_SERVER_ID}__list_dir`,
  `${SANDBOX_SERVER_ID}__dev_server_status`,
  `${SANDBOX_SERVER_ID}__dev_server_logs`,
  'get_guide',
] as const;

/** Added to the chat's own subagent rules (read-only, no questions, findings in at most 200 words). */
export const APP_ASSISTANT_SUBAGENT_INSTRUCTIONS = [
  'You are helping App Assistant, which builds a Civitai App Block for the user inside their own hosted sandbox.',
  '- Files live under /workspace; each app is a project in its <blockId> directory there. Give paths relative to /workspace.',
  '- You can only read files, list directories, read the dev server’s status and logs, and read the guide. You cannot change files, run commands or fetch web pages.',
  '- Files under <blockId>/scratch/ are throwaway probes, not part of the app.',
  '- If you say how to check the app, give the tests and the typecheck as cd <blockId> && npm test and cd <blockId> && npx tsc --noEmit, each on its own and unpiped.',
  '- The user knows each sandbox as one of their apps: say "your app", never "sandbox".',
  '- Keep your findings to at most 200 words.',
].join('\n');

/**
 * What `<civitai-chat>` gets as `subagents` when they are on, and what the server runner resolves the
 * same way; the caps and the model stay the chat's defaults.
 */
export const APP_ASSISTANT_SUBAGENTS = {
  tools: APP_ASSISTANT_SUBAGENT_TOOLS,
  instructions: APP_ASSISTANT_SUBAGENT_INSTRUCTIONS,
};
