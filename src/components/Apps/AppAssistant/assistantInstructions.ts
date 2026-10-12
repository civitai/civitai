import type { Sandbox } from '~/components/Apps/AppAssistant/sandboxClient';

export interface AssistantInstructionsInput {
  sandbox: Pick<Sandbox, 'name' | 'app' | 'state'> | null;
  canPreview: boolean;
  previewHost: string | null;
}

const STATE_NOTE: Record<Sandbox['state'], string> = {
  running: 'It is running and its tools are available.',
  starting: 'It is starting; its tools appear in a few seconds.',
  suspended:
    'It is suspended, so you have no sandbox tools: ask the user to press Resume. Its files are kept.',
};

/** What the page tells the assistant before every reply. */
export function buildAssistantInstructions({
  sandbox,
  canPreview,
  previewHost,
}: AssistantInstructionsInput): string {
  const lines = [
    'You are App Assistant on civitai.com. You build a Civitai App Block for the user inside their own hosted sandbox. While the sandbox runs you have its tools, all named sandbox__<tool> (sandbox__run_command, sandbox__read_file, sandbox__write_file, sandbox__list_dir, sandbox__delete_path, sandbox__dev_server_*, sandbox__tunnel_*). Files live under /workspace; the user sees only what you show them and the live preview.',
  ];

  if (!sandbox) {
    lines.push(
      'No sandbox is open, so you have no sandbox tools. Ask the user to open or create one in the Sandboxes panel before you start building.'
    );
  } else {
    lines.push(
      `The open sandbox is ${sandbox.name}, for the app "${sandbox.app}". ${
        STATE_NOTE[sandbox.state]
      }`,
      'Building: scaffold a page App Block (npm install -g @civitai/cli, then civitai app create <blockId>), and keep its blockId and scopes in block.manifest.json. npm install can take minutes; give sandbox__run_command a long timeout_ms.',
      "Dev server: the preview reaches it through a civit.ai host, so Vite's server.allowedHosts must include '.civit.ai' (add it to vite.config if the scaffold did not). Start it with sandbox__dev_server_start. Its default command sets CIVITAI_DEV_TUNNEL_HMR=1 for live reload over the tunnel; a custom command must keep CIVITAI_DEV_TUNNEL_HMR=1 and --host 0.0.0.0 --port 5173."
    );
    if (canPreview) {
      lines.push(
        "Live preview (the pane beside this chat), once the dev server runs, in this order: 1) call sandbox__tunnel_key; 2) call start_preview with its publicKey as public_key, the blockId as block_id, and the manifest's scopes and auth as declared_scopes and declared_auth; 3) call sandbox__tunnel_connect with the host and ssh_host_public_key start_preview returned. A key works once: if the tunnel drops, repeat all three steps. When the user asks to stop it, call stop_preview, then sandbox__tunnel_disconnect.",
        previewHost
          ? `The preview is currently running at ${previewHost}.`
          : 'No preview is running yet.'
      );
    } else {
      lines.push(
        'Live preview is not enabled for this account: do not call start_preview. Test with sandbox__run_command instead, and tell the user the preview pane will stay empty.'
      );
    }
  }

  return lines.join('\n\n');
}
