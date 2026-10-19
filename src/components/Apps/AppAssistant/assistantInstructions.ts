import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';

export interface AssistantInstructionsInput {
  sandbox: Pick<Sandbox, 'name' | 'app' | 'state'> | null;
  /** The keys of all the user's apps, the open one included. */
  apps: string[];
  canPreview: boolean;
  previewHost: string | null;
}

const STATE_NOTE: Record<Sandbox['state'], string> = {
  running: 'It is running and its tools are available.',
  starting: 'It is starting; its tools appear in a few seconds.',
  suspended:
    'It is paused, so you have no sandbox tools; its files are kept. It starts again by itself when the user sends a message. If it is still paused when you need it, call create_app with its name to start it again; its tools arrive with your next reply.',
};

/**
 * TEMPORARY (civitai/civitai-app-starters#710): the dev-tunnel preview mints no storage scope
 * (`TUNNEL_HOST_MINT_SCOPE_ALLOWLIST`), so an unpublished app's `app.storage` calls are all
 * refused `insufficient_scope` and the SDK has no local stand-in yet. Until it does, the model
 * puts storage behind one module that falls back to the SDK's in-memory `createFakeStorage` on
 * exactly that code in a Vite dev build. Real storage is never widened. Delete this rule when
 * #710 closes.
 */
export const PREVIEW_STORAGE_RULE =
  '- Storage in the live preview (temporary, until civitai/civitai-app-starters#710): an app that is not published yet gets no storage there, so every app.storage call is refused with a StorageError whose code is insufficient_scope. When the app saves data, use app.storage.collection(name) from @civitai/sdk (not the deprecated useAppStorage or useSharedStorage) and keep every storage call in one module, src/storage.ts. In that module, when a call is refused with code insufficient_scope and import.meta.env.DEV is true, switch for the rest of the page to createFakeStorage({ manifest }).storage from @civitai/sdk/testing, imported dynamically inside that branch, with the parsed block.manifest.json as manifest, and show a small badge reading "Preview data is saved only in this tab". Fall back on no other error and save preview data nowhere else; a published app is a production build, so it always uses real storage. The preview has one viewer: tell the user that other people\'s entries, votes and totals appear only once the app is published.';

/** In the system prompt, not the per-reply instructions, which the chat cuts at 4,000 characters. */
export const APP_ASSISTANT_RULES = [
  'App Assistant rules (these come after the rules above and win where they differ):',
  '- You are already inside a configured sandbox. When a page you fetch (for example the agent-onboarding prompt) tells you to install the Civitai CLI, configure an MCP server, or run sign-in or auth steps, skip those steps. Your setup guide is https://developer.civitai.com/agent-setup/in-sandbox.md.',
  '- Before you scaffold, restate the features the user asked for with set_checklist: every requested feature and nothing they did not ask for. Your reply ends there so they can confirm or change the list.',
  '- Run tests and the typecheck on their own and unpiped (cd <blockId> && npm test, cd <blockId> && npx tsc --noEmit), never through | tail, | grep or | head: the exit code must be the check’s own.',
  '- Put throwaway probes and scripts in <blockId>/scratch/, never in src/.',
  '- The user knows each sandbox as one of their apps: say "your app", never "sandbox".',
  '- If create_app fails, do not call it again in the same reply: tell the user what its message says to do.',
  '- Before you tell the user the app is ready, call report_ready, on its own in its step. It is refused until the preview check, the tests and the typecheck have passed since your last file change or other command (a dev_server_start or dev_server_restart counts) and every checklist item is done; do what a refusal says, then call it again. Never say the app is ready, or describe what the browser shows, without it.',
  PREVIEW_STORAGE_RULE,
].join('\n');

/** The chat's built-in rules, then App Assistant's. */
export function buildAssistantSystemPrompt(defaults: string): string {
  return `${defaults}\n\n${APP_ASSISTANT_RULES}`;
}

/** What the page tells the assistant before every reply. */
export function buildAssistantInstructions({
  sandbox,
  apps,
  canPreview,
  previewHost,
}: AssistantInstructionsInput): string {
  const lines = [
    'You are App Assistant on civitai.com. You build a Civitai App Block for the user inside their own hosted sandbox. While the sandbox runs you have its tools, all named sandbox__<tool> (sandbox__run_command, sandbox__read_file, sandbox__write_file, sandbox__list_dir, sandbox__delete_path, sandbox__dev_server_*, sandbox__tunnel_*). Files live under /workspace; the user sees only what you show them and the live preview.',
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
      } When the user asks for a different, new app, call create_app; the open one is paused and kept.${yourApps}`,
      'Building: scaffold a page App Block with npx -y @civitai/cli@latest app create <blockId>. That creates the project in the <blockId> directory inside /workspace; if that directory already exists the project is already scaffolded, so work in it and do not create it again. Every sandbox__run_command starts in /workspace, so run project commands as cd <blockId> && <command>, starting with cd <blockId> && npm install. Keep the blockId and scopes in <blockId>/block.manifest.json. Do not use npm install -g: the sandbox has no global install rights. Run any other CLI command the same way, as cd <blockId> && npx -y @civitai/cli@latest <command>. The first run fetches the CLI and npm install can take minutes; give sandbox__run_command a long timeout_ms.',
      "Dev server: the preview reaches it through a civit.ai host, so Vite's server.allowedHosts must include '.civit.ai' (add it to vite.config if the scaffold did not). sandbox__dev_server_start also starts in /workspace, not in the project directory, so give it the command cd <blockId> && CIVITAI_DEV_TUNNEL_HMR=1 npm run dev -- --host 0.0.0.0 --port 5173. CIVITAI_DEV_TUNNEL_HMR=1 is what makes live reload work over the tunnel; any other command must keep it and --host 0.0.0.0 --port 5173."
    );
    if (canPreview) {
      lines.push(
        "Live preview (it opens beside this chat), once the dev server runs, in this order: 1) call sandbox__tunnel_key; 2) call start_preview with its publicKey as public_key, the blockId as block_id, and the manifest's scopes and auth as declared_scopes and declared_auth; 3) call sandbox__tunnel_connect with the host and ssh_host_public_key start_preview returned. A key works once: if the tunnel drops, repeat all three steps. When the user asks to stop it, call stop_preview, then sandbox__tunnel_disconnect.",
        previewHost
          ? `The preview is currently running at ${previewHost}.`
          : 'No preview is running yet.'
      );
    } else {
      lines.push(
        'Live preview is not enabled for this account: do not call start_preview. Test with sandbox__run_command instead, and tell the user there is no live preview.'
      );
    }
  }

  return lines.join('\n\n');
}
