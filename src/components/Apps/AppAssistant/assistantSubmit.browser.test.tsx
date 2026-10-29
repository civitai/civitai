import JSZip from 'jszip';
import { describe, expect, test, vi } from 'vitest';
import type { ChatToolResult } from '@civitai/components-chat/civitai-chat';
import { createAssistantGate } from '~/components/Apps/AppAssistant/assistantGate';
import type { PreparedSubmit, SubmitReceipt } from '~/components/Apps/AppAssistant/assistantSubmit';
import { SAMPLE_NOT_AGREED, SUBMIT_NEEDS_READY, submitNotChosen } from '@civitai/app-assistant';
import {
  SubmitError,
  sendForReview,
  submitBundleFromExport,
} from '~/components/Apps/AppAssistant/assistantSubmit';

const SANDBOX = 'sbx-0123456789ab';
const APP = 'prompt-randomizer';
const MANIFEST = { blockId: APP, name: 'Prompt Randomizer', version: '0.1.0' };
const conv = { conversationId: 'c', reply: 1 };
const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };

/** The app's export, as the sandbox service zips it: everything under `<app>/`. */
async function exportOf(files: Record<string, string>, app = APP): Promise<Blob> {
  const zip = new JSZip();
  zip.folder(app);
  for (const [path, content] of Object.entries(files)) zip.file(`${app}/${path}`, content);
  return zip.generateAsync({ type: 'blob' });
}

const APP_FILES = {
  'block.manifest.json': JSON.stringify(MANIFEST),
  'package.json': '{"name":"prompt-randomizer"}',
  'src/main.ts': 'export {};',
};

/** A finished call as the page hears of it. */
const result = (name: string, output: unknown, extra: Partial<ChatToolResult> = {}) => ({
  name,
  input: name === 'sandbox__run_command' ? extra.input : {},
  output,
  isError: false,
  ...extra,
});

/** Every check report_ready asks for, passed, then report_ready itself, as the page's gate hears of them. */
async function passChecks(gate: ReturnType<typeof createAssistantGate>) {
  await passChecksOnly(gate);
  const input = { data: 'civitai' };
  await gate.beforeToolCall('report_ready', input, conv);
  const ready = await gate.tools.report_ready.execute(input, ctx);
  gate.onToolResult(result('report_ready', ready, { input }));
}

/** The checks alone: report_ready not yet called. */
async function passChecksOnly(gate: ReturnType<typeof createAssistantGate>) {
  const items = [{ label: 'Randomize a prompt', done: true }];
  gate.beforeToolCall('set_checklist', { items }, conv);
  const shown = await gate.tools.set_checklist.execute({ items }, ctx);
  gate.onToolResult(result('set_checklist', shown, { input: { items } }));
  for (const [name, input, output] of [
    ['sandbox__preview_check', {}, 'render: ok'],
    ['sandbox__run_command', { command: `cd ${APP} && npm test` }, 'exit_code: 0'],
    ['sandbox__run_command', { command: `cd ${APP} && npx tsc --noEmit` }, 'exit_code: 0'],
  ] as const) {
    gate.beforeToolCall(name, input, conv);
    gate.onToolResult(result(name, output, { input }));
  }
}

type Send = (prepared: PreparedSubmit) => Promise<SubmitReceipt>;

function setup({
  send = vi.fn<Send>(async () => ({ publishRequestId: 'pubreq_1', slug: APP, version: '0.1.0' })),
  files = APP_FILES,
  openApp,
}: {
  send?: Send;
  files?: Record<string, string>;
  /** The open app's key, for the chosen-app gate; unset, the gate is off. */
  openApp?: () => string | null;
} = {}) {
  const prepare = vi.fn(async (sandbox: string) => {
    expect(sandbox).toBe(SANDBOX);
    return submitBundleFromExport(await exportOf(files), APP);
  });
  const gate = createAssistantGate({
    currentApp: () => SANDBOX,
    submit: { prepare, send },
    ...(openApp ? { openApp } : {}),
  });
  return { gate, prepare, send };
}

/** Calls submit_for_review through the gate, as a reply would, and tells the page of the result. */
async function offer(gate: ReturnType<typeof createAssistantGate>) {
  const decision = await gate.beforeToolCall('submit_for_review', {}, conv);
  if (decision && 'refuse' in decision) {
    gate.onToolResult({
      ...result('submit_for_review', null),
      isError: true,
      refused: decision.refuse,
    });
    return { refused: decision.refuse, output: undefined };
  }
  const output = await gate.tools.submit_for_review.execute({}, ctx);
  gate.onToolResult(result('submit_for_review', output));
  return { refused: null, output };
}

const render = (gate: ReturnType<typeof createAssistantGate>, output: unknown) =>
  gate.tools.submit_for_review.render?.({
    name: 'submit_for_review',
    input: {},
    state: 'done',
    output,
  }) as HTMLElement | undefined;

const submitButton = (card: HTMLElement | undefined) =>
  [...(card?.querySelectorAll('button') ?? [])].find(
    (b) => b.textContent === 'Submit for review'
  ) ?? null;

describe('Submit for review', () => {
  test('the gate offers submit_for_review, which submits nothing by itself', async () => {
    const { gate, send, prepare } = setup();
    expect(Object.keys(gate.tools)).toContain('submit_for_review');
    await passChecks(gate);
    const { output } = await offer(gate);
    expect(output).toMatchObject({ awaitsUser: true, submit: expect.any(String) });
    expect(send).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });

  test('is refused, with no button, until the app passed the checks', async () => {
    const { gate, send } = setup();
    const { refused } = await offer(gate);
    expect(refused).toBe(SUBMIT_NEEDS_READY);
    // A refused call shows the chat's own card, never a button.
    expect(
      gate.tools.submit_for_review.render?.({
        name: 'submit_for_review',
        input: {},
        state: 'error',
        error: refused!,
      })
    ).toBeUndefined();
    expect(send).not.toHaveBeenCalled();
  });

  test('waits on report_ready: every check passed is not enough, and a refused report_ready (sample data never agreed) leaves it refused', async () => {
    const { gate } = setup();
    await passChecksOnly(gate);
    expect((await offer(gate)).refused).toBe(SUBMIT_NEEDS_READY);
    const sample = { data: 'sample' };
    const decision = await gate.beforeToolCall('report_ready', sample, conv);
    expect(decision).toMatchObject({ refuse: expect.stringContaining(SAMPLE_NOT_AGREED) });
    expect((await offer(gate)).refused).toBe(SUBMIT_NEEDS_READY);
  });

  test('a file change after the checks refuses it again', async () => {
    const { gate } = setup();
    await passChecks(gate);
    gate.beforeToolCall('sandbox__write_file', { path: 'a' }, conv);
    gate.onToolResult(result('sandbox__write_file', 'ok'));
    expect((await offer(gate)).refused).toMatch(/sandbox__preview_check: it has not run/);
  });

  test('shows the app’s name and version, and the press sends that bundle to the review route', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(
          JSON.stringify({ publishRequestId: 'pubreq_1', slug: APP, version: '0.1.0' }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    );
    const { gate, prepare } = setup({
      send: vi.fn((prepared: PreparedSubmit) => sendForReview(prepared, fetchImpl)),
      files: {
        ...APP_FILES,
        'scratch/probe.ts': 'probe',
        'prompt-randomizer-0.1.0.zip': 'an earlier package',
      },
    });
    await passChecks(gate);
    const { output } = await offer(gate);
    const card = render(gate, output)!;
    document.body.append(card);
    try {
      await expect.poll(() => submitButton(card)).not.toBeNull();
      expect(prepare).toHaveBeenCalledTimes(1);
      expect(card.querySelector('[data-testid="app-assistant-submit-what"]')?.textContent).toBe(
        'Prompt Randomizer 0.1.0 (prompt-randomizer)'
      );
      // The same card on every render: the chat renders it again on every change.
      expect(render(gate, output)).toBe(card);
      expect(fetchImpl).not.toHaveBeenCalled();

      submitButton(card)!.click();
      await expect
        .poll(() => card.querySelector('[role="status"]')?.textContent)
        .toBe(
          'Submitted Prompt Randomizer 0.1.0 for review. A moderator reviews it before it goes live in the App Store.'
        );
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      const [url, init] = fetchImpl.mock.calls[0];
      expect(url).toBe('/api/blocks/submit-version');
      expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' });
      const { bundleBase64 } = JSON.parse(String(init?.body)) as { bundleBase64: string };
      const sent = await JSZip.loadAsync(bundleBase64, { base64: true });
      // The app's files at the root, as `civitai app submit` packages them.
      expect(
        Object.keys(sent.files)
          .filter((p) => !sent.files[p].dir)
          .sort()
      ).toEqual(['block.manifest.json', 'package.json', 'src/main.ts']);
      expect(JSON.parse(await sent.file('block.manifest.json')!.async('string'))).toEqual(MANIFEST);
      expect(submitButton(card)).toBeNull();
    } finally {
      card.remove();
    }
  });

  test('a card the chat shows before the page hears of the call gets its button once it does', async () => {
    const { gate } = setup();
    await passChecks(gate);
    await gate.beforeToolCall('submit_for_review', {}, conv);
    const output = await gate.tools.submit_for_review.execute({}, ctx);
    const card = render(gate, output)!;
    expect(submitButton(card)).toBeNull();
    gate.onToolResult(result('submit_for_review', output));
    await expect.poll(() => submitButton(card)).not.toBeNull();
  });

  test('a user the route refuses sees why, and cannot press again', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ message: 'Apps are restricted to the Civitai team' }), {
          status: 403,
        })
    );
    const { gate } = setup({
      send: vi.fn((prepared: PreparedSubmit) => sendForReview(prepared, fetchImpl)),
    });
    await passChecks(gate);
    const card = render(gate, (await offer(gate)).output)!;
    await expect.poll(() => submitButton(card)).not.toBeNull();
    submitButton(card)!.click();
    await expect
      .poll(() => card.querySelector('[role="alert"]')?.textContent)
      .toBe(
        'Not submitted: Apps are restricted to the Civitai team. Your account cannot submit apps for review.'
      );
    expect(submitButton(card)).toBeNull();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('a pending submission is named in plain words with the web way to withdraw it, never a CLI command', async () => {
    // `submitVersion`'s own refusal, as the route sends it (400).
    const refusal =
      'you already have a pending submission for slug prompt-randomizer (pubreq_01ABC); withdraw it first with `civitai app withdraw pubreq_01ABC` before resubmitting';
    const fetchImpl = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ message: refusal }), { status: 400 })
    );
    const { gate } = setup({
      send: vi.fn((prepared: PreparedSubmit) => sendForReview(prepared, fetchImpl)),
    });
    await passChecks(gate);
    const card = render(gate, (await offer(gate)).output)!;
    await expect.poll(() => submitButton(card)).not.toBeNull();
    submitButton(card)!.click();
    await expect
      .poll(() => card.querySelector('[role="alert"]')?.textContent)
      .toBe(
        'Not submitted: this app already has a submission waiting for review. Withdraw it on the Build page (/apps/build), then submit again.'
      );
    expect(card.textContent).not.toMatch(/civitai app|pubreq_/);
  });

  test('any other refusal that names a CLI command is told in plain words', async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ message: 'run `civitai app doctor` and try again' }), {
          status: 400,
        })
    );
    await expect(
      sendForReview({ bundle: new Blob(['x']), manifest: MANIFEST }, fetchImpl)
    ).rejects.toThrow(
      'Not submitted: the submission was refused. Ask App Assistant to check the app, then submit again.'
    );
    // Control: a refusal without a command is passed on with what to do.
    fetchImpl.mockResolvedValueOnce(
      new Response(JSON.stringify({ message: 'manifest.name must be a non-empty string' }), {
        status: 400,
      })
    );
    await expect(
      sendForReview({ bundle: new Blob(['x']), manifest: MANIFEST }, fetchImpl)
    ).rejects.toThrow(
      'Not submitted: manifest.name must be a non-empty string. Ask App Assistant to fix this, then submit again.'
    );
  });

  test('a send that fails after the offer closed gives no button back', async () => {
    let fail!: (error: unknown) => void;
    const send = vi.fn<Send>(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        })
    );
    const { gate } = setup({ send });
    await passChecks(gate);
    const card = render(gate, (await offer(gate)).output)!;
    await expect.poll(() => submitButton(card)).not.toBeNull();
    submitButton(card)!.click();
    await expect.poll(() => send.mock.calls.length).toBe(1);
    // The conversation moves on while the bundle is on its way.
    gate.onToolResult(result('sandbox__write_file', 'ok'));
    fail(new SubmitError('Civitai could not be reached. Try again in a moment.', 0));
    await expect
      .poll(() => card.querySelector('[role="alert"]')?.textContent)
      .toBe('Civitai could not be reached. Try again in a moment.');
    expect(submitButton(card)).toBeNull();
    expect(card.textContent).toMatch(/Ask App Assistant to submit the app again\.$/);
  });

  test('a 403 for how the request came is shown as the server says it, not as the account', async () => {
    for (const [body, shown] of [
      [
        { message: 'Cross-origin request blocked' },
        'Submitting was refused: Cross-origin request blocked',
      ],
      [
        { error: 'This action requires a signed-in session or a full-access personal API key' },
        'Submitting was refused: This action requires a signed-in session or a full-access personal API key',
      ],
    ] as const) {
      const fetchImpl = vi.fn<typeof fetch>(
        async () => new Response(JSON.stringify(body), { status: 403 })
      );
      const { gate } = setup({
        send: vi.fn((prepared: PreparedSubmit) => sendForReview(prepared, fetchImpl)),
      });
      await passChecks(gate);
      const card = render(gate, (await offer(gate)).output)!;
      await expect.poll(() => submitButton(card)).not.toBeNull();
      submitButton(card)!.click();
      await expect.poll(() => card.querySelector('[role="alert"]')?.textContent).toBe(shown);
      expect(card.textContent).not.toMatch(/Your account cannot submit apps/);
      expect(submitButton(card)).toBeNull();
    }
  });

  test('a failed submit says what went wrong and leaves the button to try again', async () => {
    const send = vi
      .fn<Send>()
      .mockRejectedValueOnce(
        new SubmitError(
          'Not submitted: slug prompt-randomizer already has a pending submission from another user; wait for it to be reviewed before submitting a different bundle. Ask App Assistant to fix this, then submit again.',
          400
        )
      )
      .mockResolvedValueOnce({ publishRequestId: 'pubreq_2', slug: APP, version: '0.1.0' });
    const { gate } = setup({ send });
    await passChecks(gate);
    const card = render(gate, (await offer(gate)).output)!;
    await expect.poll(() => submitButton(card)).not.toBeNull();
    submitButton(card)!.click();
    await expect
      .poll(() => card.querySelector('[role="alert"]')?.textContent)
      .toMatch(/^Not submitted: slug prompt-randomizer already has a pending submission/);
    expect(submitButton(card)).not.toBeNull();
    submitButton(card)!.click();
    await expect
      .poll(() => card.querySelector('[role="status"]')?.textContent)
      .toMatch(/^Submitted Prompt Randomizer 0\.1\.0 for review/);
    expect(send).toHaveBeenCalledTimes(2);
  });

  test('the offer closes when anything else happens: a later call, a new reply, a message, another app', async () => {
    for (const moveOn of [
      (gate: ReturnType<typeof createAssistantGate>) =>
        gate.onToolResult(result('sandbox__write_file', 'ok')),
      (gate: ReturnType<typeof createAssistantGate>) =>
        gate.beforeToolCall('sandbox__read_file', {}, { ...conv, reply: 2 }),
      (gate: ReturnType<typeof createAssistantGate>) => gate.answered(),
      (gate: ReturnType<typeof createAssistantGate>) => gate.appChanged('sbx-other'),
    ]) {
      const { gate, send } = setup();
      await passChecks(gate);
      const card = render(gate, (await offer(gate)).output)!;
      await expect.poll(() => submitButton(card)).not.toBeNull();
      moveOn(gate);
      expect(submitButton(card)).toBeNull();
      expect(card.textContent).toMatch(/Ask App Assistant to submit the app again\.$/);
      expect(send).not.toHaveBeenCalled();
    }
  });

  test('a new chat cannot submit the open app it did not make or choose, even once every check passed', async () => {
    const { gate, send, prepare } = setup({ openApp: () => APP });
    await passChecks(gate);
    const { refused } = await offer(gate);
    expect(refused).toBe(submitNotChosen(APP));
    expect(prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test('the chat that made the open app gets the button', async () => {
    const { gate } = setup({ openApp: () => APP });
    await gate.beforeToolCall('create_app', { name: 'Prompt randomizer' }, conv);
    gate.onToolResult(
      result('create_app', { app: APP, state: 'starting', note: 'n' }, { input: { name: 'x' } })
    );
    await passChecks(gate);
    const { refused, output } = await offer(gate);
    expect(refused).toBeNull();
    const card = render(gate, output)!;
    await expect.poll(() => submitButton(card)).not.toBeNull();
  });

  test('an offer this page did not make (an earlier visit’s) shows no button', async () => {
    const { gate, prepare } = setup();
    await passChecks(gate);
    const { output } = await offer(gate);
    const other = setup().gate;
    const restored = render(other, JSON.parse(JSON.stringify(output)));
    expect(submitButton(restored)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  test('without a way to submit, the call keeps the chat’s default card', async () => {
    const gate = createAssistantGate();
    expect(gate.tools.submit_for_review.render).toBeUndefined();
  });
});

describe('the bundle a press sends', () => {
  test('refuses a manifest naming another app, which would submit under another slug', async () => {
    const exported = await exportOf({
      ...APP_FILES,
      'block.manifest.json': JSON.stringify({ ...MANIFEST, blockId: 'someone-elses-app' }),
    });
    await expect(submitBundleFromExport(exported, APP)).rejects.toThrow(
      'Your app\'s block.manifest.json names its blockId "someone-elses-app", not "prompt-randomizer". Ask App Assistant to fix it.'
    );
  });

  test('refuses an app with no manifest', async () => {
    const { 'block.manifest.json': _, ...rest } = APP_FILES;
    await expect(submitBundleFromExport(await exportOf(rest), APP)).rejects.toThrow(
      'Your app has no block.manifest.json, so it cannot be submitted. Ask App Assistant to add it.'
    );
  });

  test('takes the app folder off an export, and uses an export with the manifest at its root as it is', async () => {
    const files = { ...APP_FILES, 'scratch/probe.ts': 'probe', 'old.zip': 'z' };
    const rooted = new JSZip();
    for (const [path, content] of Object.entries(files)) rooted.file(path, content);
    for (const exported of [await exportOf(files), await rooted.generateAsync({ type: 'blob' })]) {
      const { bundle, manifest } = await submitBundleFromExport(exported, APP);
      expect(manifest).toEqual(MANIFEST);
      const zip = await JSZip.loadAsync(bundle);
      expect(
        Object.keys(zip.files)
          .filter((path) => !zip.files[path].dir)
          .sort()
      ).toEqual(['block.manifest.json', 'package.json', 'src/main.ts']);
    }
  });

  test('keeps a nested scratch folder, which is the app’s own source', async () => {
    const { bundle } = await submitBundleFromExport(
      await exportOf({ ...APP_FILES, 'src/scratch/util.ts': 'x' }),
      APP
    );
    const zip = await JSZip.loadAsync(bundle);
    expect(zip.file('src/scratch/util.ts')).not.toBeNull();
  });
});
