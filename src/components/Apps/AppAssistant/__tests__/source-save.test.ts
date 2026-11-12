import { describe, expect, it, vi } from 'vitest';
import * as shared from '@civitai/app-assistant';
import { SOURCE_SAVE_ROUTE, saveAppSource } from '~/components/Apps/AppAssistant/appSourceSave';

/**
 * App Assistant → the app's source repo: WHEN a save is asked for. The gate tells the scheduler of
 * every call that changed the open app's files (`onAppChanged`), on the page and on the server
 * runner alike; the scheduler makes one save per quiet spell, and one at the end of a reply.
 * New surface: invariant guards.
 */

const result = (over: Partial<shared.ToolResult>): shared.ToolResult => ({
  name: 'sandbox__write_file',
  input: { path: 'a/x.ts' },
  output: 'wrote',
  isError: false,
  ...over,
});

describe('the gate tells of each change to the open app', () => {
  function gateWith(open: string | null = 'tip-calc') {
    const changed: string[] = [];
    const core = shared.createGateCore({
      openApp: () => open,
      onAppChanged: (app) => changed.push(app),
    });
    return { core, changed };
  }

  it('a file write, an edit, a delete and an ordinary command each tell; reads and checks do not', () => {
    const { core, changed } = gateWith();
    for (const r of [
      result({ name: 'sandbox__write_file' }),
      result({ name: 'sandbox__edit_file' }),
      result({ name: 'sandbox__delete_path' }),
      result({ name: 'sandbox__run_command', input: { command: 'npm install' } }),
      result({ name: 'sandbox__read_file' }),
      result({ name: 'sandbox__list_dir' }),
      result({ name: 'sandbox__preview_check' }),
      result({ name: 'sandbox__run_checks' }),
      result({ name: 'sandbox__run_command', input: { command: 'cd a && npm test' } }),
      result({ name: 'set_checklist', input: { items: [] } }),
    ])
      core.onToolResult(r);
    expect(changed).toEqual(['tip-calc', 'tip-calc', 'tip-calc', 'tip-calc']);
  });

  it('a failed, refused or stopped call does not tell; a subagent’s change does', () => {
    const { core, changed } = gateWith();
    core.onToolResult(result({ isError: true }));
    core.onToolResult(result({ refused: 'no' }));
    core.onToolResult(result({ stopped: true }));
    expect(changed).toEqual([]);
    core.onToolResult(result({ subagent: 'helper-1' }));
    expect(changed).toEqual(['tip-calc']);
  });

  it('no open app: nothing to save', () => {
    const { core, changed } = gateWith(null);
    core.onToolResult(result({}));
    expect(changed).toEqual([]);
  });
});

describe('createSourceSaveScheduler', () => {
  function harness() {
    const saves: string[] = [];
    let release: (() => void) | null = null;
    const timers: Array<{ fn: () => void; ms: number; live: boolean }> = [];
    const scheduler = shared.createSourceSaveScheduler({
      save: async (app) => {
        saves.push(app);
        await new Promise<void>((r) => (release = r));
      },
      quietMs: 1000,
      setTimer: (fn, ms) => {
        const t = { fn, ms, live: true };
        timers.push(t);
        return t;
      },
      clearTimer: (t) => {
        (t as { live: boolean }).live = false;
      },
    });
    const fire = () => {
      const t = timers.filter((x) => x.live).at(-1);
      if (!t) throw new Error('no timer');
      t.live = false;
      t.fn();
    };
    const settle = async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    };
    return { scheduler, saves, timers, fire, settle, release: () => release?.() };
  }

  it('many changes in one spell make ONE save, after the quiet time', async () => {
    const h = harness();
    h.scheduler.changed('a');
    h.scheduler.changed('a');
    h.scheduler.changed('a');
    expect(h.saves).toEqual([]);
    expect(h.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([1000]);
    h.fire();
    await h.settle();
    expect(h.saves).toEqual(['a']);
  });

  it('flush saves now (the end of a reply), and resolves only once the save finished', async () => {
    const h = harness();
    h.scheduler.changed('a');
    let done = false;
    const flushed = h.scheduler.flush().then(() => (done = true));
    await h.settle();
    expect(h.saves).toEqual(['a']);
    expect(done).toBe(false);
    h.release();
    await flushed;
    expect(done).toBe(true);
    expect(h.timers.some((t) => t.live)).toBe(false);
  });

  it('a change during a save is saved after it, never alongside it', async () => {
    const h = harness();
    h.scheduler.changed('a');
    h.fire();
    await h.settle();
    h.scheduler.changed('a');
    const flushed = h.scheduler.flush();
    await h.settle();
    expect(h.saves).toEqual(['a']); // the second waits for the first
    h.release();
    await h.settle();
    expect(h.saves).toEqual(['a', 'a']);
    h.release();
    await flushed;
  });

  it('another app opening while one waits saves both, the first first', async () => {
    const h = harness();
    h.scheduler.changed('a');
    h.scheduler.changed('b');
    await h.settle();
    expect(h.saves).toEqual(['a']);
    h.release();
    await h.settle();
    expect(h.saves).toEqual(['a', 'b']);
    h.release();
  });

  it('a save that throws is reported and the next change still saves', async () => {
    const errors: unknown[] = [];
    let calls = 0;
    const scheduler = shared.createSourceSaveScheduler({
      save: async () => {
        calls += 1;
        if (calls === 1) throw new Error('down');
      },
      onError: (e) => errors.push(e),
    });
    scheduler.changed('a');
    await scheduler.flush();
    scheduler.changed('a');
    await scheduler.flush();
    expect(calls).toBe(2);
    expect(errors).toHaveLength(1);
    scheduler.dispose();
  });

  it('dispose drops a pending save', async () => {
    const h = harness();
    h.scheduler.changed('a');
    h.scheduler.dispose();
    await h.scheduler.flush();
    expect(h.saves).toEqual([]);
  });
});

describe('saveAppSource — the page’s save', () => {
  it('POSTs only the app’s key to the session route, and never throws', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}'));
    await saveAppSource('tip-calc', fetchImpl as unknown as typeof fetch);
    expect(fetchImpl).toHaveBeenCalledWith(SOURCE_SAVE_ROUTE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"app":"tip-calc"}',
      credentials: 'same-origin',
      keepalive: true,
    });
    await expect(
      saveAppSource('tip-calc', (async () => {
        throw new Error('offline');
      }) as unknown as typeof fetch)
    ).resolves.toBeUndefined();
  });
});
