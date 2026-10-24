import { describe, expect, it } from 'vitest';
import { assistantSystemPrompt } from '@civitai/app-assistant';
import {
  APP_ASSISTANT_RULES,
  APP_ASSISTANT_SUBAGENT_RULES,
  buildAssistantInstructions,
  buildAssistantSystemPrompt,
  buildAssistantSystemPromptWithSubagents,
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
      /other apps are tip-calculator, moodboard; to keep working on one of those, they pick it from the app switcher at the top of the page/
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

  it('always starts the dev server with the tunnel flag, which the preview needs to load at all', () => {
    // The whole paragraph: since civitai/cli#859 a Vite scaffold sends the headers the preview needs
    // only with CIVITAI_DEV_TUNNEL_HMR=1, so a reworded dev-server step must be re-read here.
    const DEV_SERVER =
      "Dev server: the preview reaches it through a civit.ai host, so Vite's server.allowedHosts must include '.civit.ai' (add it to vite.config if the scaffold did not). Always start it with sandbox__dev_server_start and exactly this command (the tool starts in /workspace, not in the project directory): cd <blockId> && CIVITAI_DEV_TUNNEL_HMR=1 npm run dev -- --host 0.0.0.0 --port 5173. Never start it with a plain npm run dev, or any command without CIVITAI_DEV_TUNNEL_HMR=1: that flag is what makes the dev server send the headers the preview needs to load (without it the preview is blank), and it also makes live reload work over the tunnel. Keep --host 0.0.0.0 --port 5173 in any command you give it.";
    for (const runner of ['browser', 'remote'] as const)
      for (const canPreview of [true, false]) {
        const paragraphs = buildAssistantInstructions({
          sandbox: running,
          apps: ['my-app'],
          canPreview,
          previewHost: null,
          runner,
        }).split('\n\n');
        expect(paragraphs.filter((p) => p.startsWith('Dev server:'))).toEqual([DEV_SERVER]);
      }
    // Nowhere is the flag described as being for live reload alone.
    const text = buildAssistantInstructions({
      sandbox: running,
      apps: ['my-app'],
      canPreview: true,
      previewHost: null,
    });
    expect(text).not.toMatch(/CIVITAI_DEV_TUNNEL_HMR=1 is what makes live reload/);
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
    [
      'suspended',
      /no sandbox tools; its files are kept\. It starts again by itself when the user sends a message/,
    ],
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
        '- If create_app fails, do not call it again in the same reply: tell the user what its message says to do.',
        "- Price a generation with estimatedCost(estimate) from @civitai/sdk where the installed version exports it; otherwise an estimate is priced when its status is not 'failed' and cost.total is a number (0 is a price), and that number is the price. A priced estimate comes back 'pending', not 'succeeded': never require 'succeeded'.",
        '- Before you tell the user the app is ready, call report_ready, on its own in its step. It is refused until the preview check, the tests and the typecheck have passed since your last file change or other command (a dev_server_start or dev_server_restart counts) and every checklist item is done; do what a refusal says, then call it again. Never say the app is ready, or describe what the browser shows, without it.',
      ].join('\n')
    );
  });
});

describe('pricing an estimate', () => {
  // An app the assistant built treated `estimate.status !== 'succeeded'` as "no price", but a
  // priced estimate comes back 'pending' with cost.total, so it showed "couldn't get a price"
  // for every estimate. The whole line, on both runners and with or without subagents.
  const ESTIMATE_RULE =
    "- Price a generation with estimatedCost(estimate) from @civitai/sdk where the installed version exports it; otherwise an estimate is priced when its status is not 'failed' and cost.total is a number (0 is a price), and that number is the price. A priced estimate comes back 'pending', not 'succeeded': never require 'succeeded'.";

  it.each([
    ['browser', false],
    ['browser', true],
    ['remote', false],
    ['remote', true],
  ] as const)('the %s system prompt (subagents: %s) tells the assistant how', (runner, subagents) => {
    const lines = assistantSystemPrompt(runner, subagents)('BUILT-IN RULES').split('\n');
    expect(lines.filter((line) => line.includes('estimate'))).toEqual([ESTIMATE_RULE]);
  });
});

describe('buildAssistantSystemPromptWithSubagents', () => {
  it('is the prompt without subagents, then when to start one', () => {
    expect(buildAssistantSystemPromptWithSubagents('BUILT-IN RULES')).toBe(
      `BUILT-IN RULES\n\n${APP_ASSISTANT_RULES}\n${APP_ASSISTANT_SUBAGENT_RULES}`
    );
    expect(buildAssistantSystemPrompt('BUILT-IN RULES')).not.toContain('dispatch_agent');
  });

  it('pins the whole subagent rule text: a reworded rule must be re-read here', () => {
    expect(APP_ASSISTANT_SUBAGENT_RULES).toBe(
      [
        '- dispatch_agent starts a read-only subagent that reads files, lists directories, reads the dev server’s status and logs and reads the guide, then returns a short summary. Prefer it to reading yourself: everything you read stays in your context for the rest of the reply, and a subagent’s reading does not.',
        '- Dispatch, with every subagent of the step in that one step so they run at the same time: before you change an existing app (one subagent per area: its source, its tests, the guide pages you need); whenever answering a question would take you more than three reads; and to find where something is defined or used.',
        '- Do it yourself only when one or two reads will do, or when you need a file’s exact contents to edit it. A subagent cannot change files, run commands, fetch web pages, start the dev server or the preview, or run the tests or the typecheck.',
        '- A subagent sees nothing of this chat: write each task as a self-contained brief naming the files or pages to look at, what to find out and what to return.',
      ].join('\n')
    );
  });
});
