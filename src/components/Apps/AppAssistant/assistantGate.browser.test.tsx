import { describe, expect, test, vi } from 'vitest';
import {
  createAssistantGate,
  renderChecklist,
  renderReady,
} from '~/components/Apps/AppAssistant/assistantGate';

describe('the set_checklist card', () => {
  test('shows every item with whether it is done', () => {
    const card = renderChecklist({
      name: 'set_checklist',
      input: { items: [{ label: 'Type a description', done: true }, { label: 'Download' }] },
      state: 'done',
    });
    expect(card?.getAttribute('aria-label')).toBe('Feature checklist');
    expect([...card!.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '☑ Type a description',
      '☐ Download',
    ]);
  });

  test('keeps the default card for input it cannot read', () => {
    expect(
      renderChecklist({ name: 'set_checklist', input: { items: 'oops' }, state: 'calling' })
    ).toBeUndefined();
  });

  test('tells the user a list planned on sample data is not real Civitai data, and only then', () => {
    const items = [{ label: 'Search models' }];
    const card = (data?: string) =>
      renderChecklist({
        name: 'set_checklist',
        input: { items, ...(data ? { data } : {}) },
        state: 'done',
      });
    expect(card('sample')?.textContent).toBe(
      'Feature checklist☐ Search models⚠ Sample data: this app will show made-up examples, not real Civitai data.'
    );
    for (const data of [undefined, 'civitai', 'none'])
      expect(card(data)?.textContent).toBe('Feature checklist☐ Search models');
  });

  test('is the view the tool carries', () => {
    const call = {
      name: 'set_checklist',
      input: { items: [{ label: 'Download' }] },
      state: 'done' as const,
    };
    expect((createAssistantGate().tools.set_checklist.render!(call) as HTMLElement).outerHTML).toBe(
      renderChecklist(call)!.outerHTML
    );
  });
});

describe('Build it under the checklist', () => {
  const items = [{ label: 'Ask questions' }];
  const conv = { conversationId: 'c', reply: 1 };
  const ctx = { signal: new AbortController().signal, conversationId: 'c', files: [] };

  async function shownChecklist(onBuild = vi.fn()) {
    const gate = createAssistantGate({ onBuild });
    gate.beforeToolCall('set_checklist', { items }, conv);
    const output = await gate.tools.set_checklist.execute({ items }, ctx);
    const card = () =>
      gate.tools.set_checklist.render!({
        name: 'set_checklist',
        input: { items },
        state: 'done',
        output,
      }) as HTMLElement;
    return { gate, output, card, onBuild };
  }
  const buildButton = (card: HTMLElement) =>
    [...card.querySelectorAll('button')].find((b) => b.textContent === 'Build it') ?? null;

  test('the card of a checklist that waits for the user offers Build it until the user answers', async () => {
    const { gate, card, onBuild } = await shownChecklist();
    const shown = card();
    document.body.append(shown);
    const button = buildButton(shown)!;
    expect(getComputedStyle(button).minHeight).toBe('44px');
    button.click();
    expect(onBuild).toHaveBeenCalledTimes(1);
    // The page decides when it goes: once the message went, or once it put it in the message box.
    expect(buildButton(shown)).not.toBeNull();
    gate.answered();
    expect(buildButton(shown)).toBeNull();
    expect(buildButton(card())).toBeNull();
    shown.remove();
  });

  test('goes when another app opens, and stays when the same one does', async () => {
    let app: string | null = 'sbx-a';
    const gate = createAssistantGate({ onBuild: vi.fn(), currentApp: () => app });
    gate.beforeToolCall('set_checklist', { items }, conv);
    const output = await gate.tools.set_checklist.execute({ items }, ctx);
    const card = () =>
      gate.tools.set_checklist.render!({
        name: 'set_checklist',
        input: { items },
        state: 'done',
        output,
      }) as HTMLElement;
    const shown = card();
    gate.appChanged('sbx-a');
    expect(buildButton(shown)).not.toBeNull();
    app = 'sbx-b';
    gate.appChanged('sbx-b');
    expect(buildButton(shown)).toBeNull();
    expect(buildButton(card())).toBeNull();
  });

  test('on the server runner, stays when the page then opens the app the checklist was made for', async () => {
    // The runner reports create_app, then set_checklist (tagged with the new app's key), before the
    // page has refetched its apps and switched to the new app: the page's open app is still the old one.
    let open = 'sbx-old';
    const keys: Record<string, string> = {
      'sbx-old': 'old-app',
      'sbx-new': 'new-app',
      'sbx-other': 'other-app',
    };
    const gate = createAssistantGate({
      onBuild: vi.fn(),
      currentApp: () => open,
      appKeyOf: (sandbox) => (sandbox ? keys[sandbox] ?? null : null),
    });
    const output = {
      shown: true,
      awaitsUser: true,
      checklist: 'run1-1',
      note: 'shown',
      app: 'new-app',
    };
    gate.onToolResult({ name: 'set_checklist', input: { items }, output, isError: false });
    const card = () =>
      gate.tools.set_checklist.render!({
        name: 'set_checklist',
        input: { items },
        state: 'done',
        output,
      }) as HTMLElement;
    const shown = card();
    expect(buildButton(shown)).not.toBeNull();
    // The page follows create_app to the new app: Build it stays.
    open = 'sbx-new';
    gate.appChanged('sbx-new');
    expect(buildButton(shown)).not.toBeNull();
    expect(buildButton(card())).not.toBeNull();
    // NEGATIVE CONTROL: the user then opens a different app: Build it goes.
    open = 'sbx-other';
    gate.appChanged('sbx-other');
    expect(buildButton(shown)).toBeNull();
  });

  test('goes once the next reply starts, or the user answers some other way', async () => {
    const first = await shownChecklist();
    first.gate.beforeToolCall('sandbox__read_file', {}, { ...conv, reply: 2 });
    expect(buildButton(first.card())).toBeNull();

    const second = await shownChecklist();
    const shown = second.card();
    expect(buildButton(shown)).not.toBeNull();
    second.gate.answered();
    expect(buildButton(shown)).toBeNull();
    expect(buildButton(second.card())).toBeNull();
  });

  test('a card from another page load, or an unchanged checklist, offers nothing', async () => {
    const { output } = await shownChecklist();
    const other = createAssistantGate({ onBuild: vi.fn() });
    const restored = other.tools.set_checklist.render!({
      name: 'set_checklist',
      input: { items },
      state: 'done',
      output: JSON.parse(JSON.stringify(output)),
    }) as HTMLElement;
    expect(buildButton(restored)).toBeNull();

    const { gate } = await shownChecklist();
    const again = await gate.tools.set_checklist.execute(
      { items: [{ ...items[0], done: true }] },
      ctx
    );
    expect(again).not.toHaveProperty('awaitsUser');
  });

  test('a first list offers Build it even with every item done', async () => {
    const done = [{ label: 'Ask questions', done: true }];
    const gate = createAssistantGate({ onBuild: vi.fn() });
    gate.beforeToolCall('set_checklist', { items: done }, conv);
    const output = await gate.tools.set_checklist.execute({ items: done }, ctx);
    expect(output).toMatchObject({ shown: true, awaitsUser: true });
    const card = gate.tools.set_checklist.render!({
      name: 'set_checklist',
      input: { items: done },
      state: 'done',
      output,
    }) as HTMLElement;
    expect(buildButton(card)).not.toBeNull();
  });

  test('a changed list with every item done offers no Build it, from the page or from a server runner', async () => {
    const done = [{ label: 'Ask questions well', done: true }];
    const gate = createAssistantGate({ onBuild: vi.fn() });
    gate.beforeToolCall('set_checklist', { items }, conv);
    await gate.tools.set_checklist.execute({ items }, ctx);
    const output = await gate.tools.set_checklist.execute({ items: done }, ctx);
    expect(output).toEqual({ updated: true, open: 0 });
    const card = (input: unknown, shown: unknown) =>
      gate.tools.set_checklist.render!({
        name: 'set_checklist',
        input,
        state: 'done',
        output: shown,
      }) as HTMLElement;
    expect(buildButton(card({ items: done }, output))).toBeNull();

    // A runner's report that says it waits (a runner without the rule) is not taken for a done list.
    const reported = { shown: true, awaitsUser: true, checklist: 'runner-1' };
    gate.onToolResult({
      name: 'set_checklist',
      input: { items: done },
      output: reported,
      isError: false,
    });
    expect(buildButton(card({ items: done }, reported))).toBeNull();
    // Control: the same report for a list with an item open offers it.
    gate.onToolResult({
      name: 'set_checklist',
      input: { items },
      output: reported,
      isError: false,
    });
    expect(buildButton(card({ items }, reported))).not.toBeNull();
  });
});

describe('the report_ready card', () => {
  test('says what the checks were when report_ready passed: a test browser, not the live preview', () => {
    const card = renderReady({
      name: 'report_ready',
      input: {},
      state: 'done',
      output: { ready: true, note: 'x' },
    });
    expect(card?.getAttribute('role')).toBe('status');
    expect(card?.textContent).toBe(
      '✓ Checked: the app renders in a test browser, the tests and the typecheck pass, and every checklist item is done.'
    );
  });

  test('says so when the app shows sample data', () => {
    const card = renderReady({
      name: 'report_ready',
      input: { data: 'sample' },
      state: 'done',
      output: { ready: true, data: 'sample', note: 'x' },
    });
    expect(card?.textContent).toBe(
      '✓ Checked: the app renders in a test browser, the tests and the typecheck pass, and every checklist item is done. ⚠ This app shows sample data, not real Civitai data.'
    );
  });

  test.each([
    { state: 'error' as const, error: 'Not ready yet.' },
    { state: 'calling' as const },
    { state: 'done' as const, output: { error: 'Not ready yet.' } },
  ])('keeps the default card for a $state call that did not pass', (call) => {
    expect(renderReady({ name: 'report_ready', input: {}, ...call })).toBeUndefined();
  });

  test('is the view the tool carries', () => {
    expect(createAssistantGate().tools.report_ready.render).toBe(renderReady);
  });
});
