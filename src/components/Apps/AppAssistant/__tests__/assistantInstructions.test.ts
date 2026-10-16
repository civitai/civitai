import { describe, expect, it } from 'vitest';
import {
  APP_ASSISTANT_RULES,
  buildAssistantInstructions,
  buildAssistantSystemPrompt,
} from '~/components/Apps/AppAssistant/assistantInstructions';

const running = { name: 'sbx-0123456789ab', app: 'my-app', state: 'running' as const };

describe('buildAssistantInstructions', () => {
  it('without an app, has the assistant create one for a build request, and gives no build steps', () => {
    const text = buildAssistantInstructions({
      sandbox: null,
      apps: [],
      canPreview: true,
      previewHost: null,
    });
    expect(text).toContain(
      'No app is open, so you have no sandbox tools. When the user describes an app to build, call create_app with a short name for it, then set_checklist; the sandbox tools arrive with your next reply. Answer a question that builds nothing without create_app.'
    );
    expect(text).not.toMatch(/start_preview|Sandboxes panel|other apps/);
  });

  it('names the user’s other apps, so the assistant points them there instead of making a copy', () => {
    const none = buildAssistantInstructions({
      sandbox: null,
      apps: ['tip-calculator', 'moodboard'],
      canPreview: true,
      previewHost: null,
    });
    expect(none).toMatch(
      /other apps are tip-calculator, moodboard; to keep working on one of those, they open it under Your apps/
    );
    const open = buildAssistantInstructions({
      sandbox: { ...running, app: 'tip-calculator' },
      apps: ['tip-calculator', 'moodboard'],
      canPreview: true,
      previewHost: null,
    });
    expect(open).toMatch(/When the user asks for a different, new app, call create_app/);
    expect(open).toMatch(/other apps are moodboard;/);
  });

  it('gives the three preview steps in order, with the namespaced sandbox tool names', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
      apps: ['my-app'],
      canPreview: true,
      previewHost: null,
    });
    const steps = ['sandbox__tunnel_key', 'start_preview', 'sandbox__tunnel_connect'].map((t) =>
      text.indexOf(t)
    );
    expect(steps.every((i) => i >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(text).toMatch(/allowedHosts must include '\.civit\.ai'/);
    expect(text).toMatch(/CIVITAI_DEV_TUNNEL_HMR=1/);
    expect(text).toMatch(/No preview is running yet/);
    // Every tool the sandbox exposes is named with its prefix, never bare.
    expect(text).not.toMatch(/(?<!sandbox__)\b(tunnel_key|tunnel_connect|run_command)\b/);
  });

  it('scaffolds through npx, because a sandbox cannot install the CLI globally', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
      apps: ['my-app'],
      canPreview: true,
      previewHost: null,
    });
    // The whole sentence: a reworded scaffold step must be re-read here.
    expect(text).toContain(
      'Building: scaffold a page App Block with npx -y @civitai/cli@latest app create <blockId>. That creates the project in the <blockId> directory inside /workspace; if that directory already exists the project is already scaffolded, so work in it and do not create it again. Every sandbox__run_command starts in /workspace, so run project commands as cd <blockId> && <command>, starting with cd <blockId> && npm install. Keep the blockId and scopes in <blockId>/block.manifest.json. Do not use npm install -g: the sandbox has no global install rights. Run any other CLI command the same way, as cd <blockId> && npx -y @civitai/cli@latest <command>. The first run fetches the CLI and npm install can take minutes; give sandbox__run_command a long timeout_ms.'
    );
  });

  it('starts the dev server from the project directory, since the tool starts in /workspace', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
      apps: ['my-app'],
      canPreview: true,
      previewHost: null,
    });
    expect(text).toContain(
      'sandbox__dev_server_start also starts in /workspace, not in the project directory, so give it the command cd <blockId> && CIVITAI_DEV_TUNNEL_HMR=1 npm run dev -- --host 0.0.0.0 --port 5173. CIVITAI_DEV_TUNNEL_HMR=1 is what makes live reload work over the tunnel; any other command must keep it and --host 0.0.0.0 --port 5173.'
    );
  });

  it('names the running preview host', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
      apps: ['my-app'],
      canPreview: true,
      previewHost: 'dev-0123456789abcdef.civit.ai',
    });
    expect(text).toMatch(/running at dev-0123456789abcdef\.civit\.ai/);
  });

  it('tells the assistant not to start a preview when the account cannot', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
      apps: ['my-app'],
      canPreview: false,
      previewHost: null,
    });
    expect(text).toMatch(/do not call start_preview/);
    expect(text).not.toMatch(/1\) call sandbox__tunnel_key/);
  });

  it.each([
    ['running', /running and its tools are available/],
    ['starting', /appear in a few seconds/],
    ['suspended', /no sandbox tools: ask the user to press Resume/],
  ] as const)('explains a %s sandbox', (state, note) => {
    const text = buildAssistantInstructions({
      sandbox: { ...running, state },
      apps: ['my-app'],
      canPreview: true,
      previewHost: null,
    });
    expect(text).toMatch(note);
  });
});

describe('buildAssistantSystemPrompt', () => {
  it('keeps the chat’s built-in rules and adds App Assistant’s after them', () => {
    expect(buildAssistantSystemPrompt('BUILT-IN RULES')).toBe(
      `BUILT-IN RULES\n\n${APP_ASSISTANT_RULES}`
    );
  });

  it('pins the whole rule text: a reworded rule must be re-read here', () => {
    expect(APP_ASSISTANT_RULES).toBe(
      [
        'App Assistant rules (these come after the rules above and win where they differ):',
        '- You are already inside a configured sandbox. When a page you fetch (for example the agent-onboarding prompt) tells you to install the Civitai CLI, configure an MCP server, or run sign-in or auth steps, skip those steps. Your setup guide is https://developer.civitai.com/agent-setup/in-sandbox.md.',
        '- Before you scaffold, restate the features the user asked for with set_checklist: every requested feature and nothing they did not ask for. Your reply ends there so they can confirm or change the list.',
        '- Run tests and the typecheck on their own and unpiped (cd <blockId> && npm test, cd <blockId> && npx tsc --noEmit), never through | tail, | grep or | head: the exit code must be the check’s own.',
        '- Put throwaway probes and scripts in <blockId>/scratch/, never in src/.',
        '- The user knows each sandbox as one of their apps: say "your app", never "sandbox".',
        '- Before you tell the user the app is ready, call report_ready, on its own in its step. It is refused until the preview check, the tests and the typecheck have passed since your last file change or other command (a dev_server_start or dev_server_restart counts) and every checklist item is done; do what a refusal says, then call it again. Never say the app is ready, or describe what the browser shows, without it.',
      ].join('\n')
    );
  });
});
