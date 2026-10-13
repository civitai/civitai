import { describe, expect, it } from 'vitest';
import { buildAssistantInstructions } from '~/components/Apps/AppAssistant/assistantInstructions';

const running = { name: 'sbx-0123456789ab', app: 'my-app', state: 'running' as const };

describe('buildAssistantInstructions', () => {
  it('without a sandbox, says there are no sandbox tools and gives no build steps', () => {
    const text = buildAssistantInstructions({ sandbox: null, canPreview: true, previewHost: null });
    expect(text).toMatch(/No sandbox is open/);
    expect(text).not.toMatch(/start_preview/);
  });

  it('gives the three preview steps in order, with the namespaced sandbox tool names', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
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
      canPreview: true,
      previewHost: null,
    });
    // The whole sentence: a reworded scaffold step must be re-read here.
    expect(text).toContain(
      'Building: scaffold a page App Block with npx -y @civitai/cli@latest app create <blockId>, and keep its blockId and scopes in block.manifest.json. Do not use npm install -g: the sandbox has no global install rights. Run any other CLI command the same way, as npx -y @civitai/cli@latest <command>. The first run fetches the CLI and npm install can take minutes; give sandbox__run_command a long timeout_ms.'
    );
    expect(text).not.toMatch(/npm install -g @civitai\/cli/);
  });

  it('names the running preview host', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
      canPreview: true,
      previewHost: 'dev-0123456789abcdef.civit.ai',
    });
    expect(text).toMatch(/running at dev-0123456789abcdef\.civit\.ai/);
  });

  it('tells the assistant not to start a preview when the account cannot', () => {
    const text = buildAssistantInstructions({
      sandbox: running,
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
      canPreview: true,
      previewHost: null,
    });
    expect(text).toMatch(note);
  });
});
