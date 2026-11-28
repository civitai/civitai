import type { ToolSet } from 'ai';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  PLATFORM_UPDATE_MERGED,
  type PendingPlatformUpdate,
  type PlatformUpdateResolve,
  type PlatformUpdateSource,
} from '../app-assistant/platform-updates';
import { AppAssistantTools } from '../app-assistant/provider';
import type { OpenTools } from '../core/interfaces';
import { chosenApp } from '../test-support/chosen-app';
import { FakeSandboxService } from '../test-support/fake-sandbox';

/**
 * The seam: platform updates as `AppAssistantTools.open` runs them at a reply's start, against the
 * fake sandbox service's real MCP tools. What the provider wires: the apply runs, its lines reach
 * the reply's instructions, and `platform_update_merged` is offered whenever platform updates are
 * configured (a hand-off is rebuilt from civitai's open list, never from the runner's memory).
 */

const quiet = { info: () => undefined, warn: () => undefined, error: () => undefined };

let fake: FakeSandboxService;
let files: Map<string, string>;
let opened: OpenTools[];

beforeEach(async () => {
  fake = new FakeSandboxService();
  files = new Map();
  fake.tools.set('read_file', (args) => {
    const content = files.get(String(args.path));
    if (content === undefined) throw new Error('ENOENT');
    return JSON.stringify({ content, size: Buffer.byteLength(content), truncated: false });
  });
  fake.tools.set('write_file', (args) => {
    files.set(String(args.path), String(args.content));
    return 'wrote';
  });
  fake.tools.set('delete_path', (args) => {
    files.delete(String(args.path));
    return 'deleted';
  });
  fake.tools.set('run_command', (args) => {
    const match = /\[ -e '((?:[^']|'\\'')*)' \]/.exec(String(args.command));
    const there = match ? files.has(match[1].replace(/'\\''/g, "'")) : false;
    return `exit_code: 0\ntimed_out: false\n---\n${there ? 'present' : 'absent'}\n`;
  });
  await fake.start();
  opened = [];
});

afterEach(async () => {
  await Promise.all(opened.map((tools) => tools.close()));
  await fake.stop();
});

class Civitai implements PlatformUpdateSource {
  readonly resolved: string[] = [];
  lists = 0;
  constructor(public updates: PendingPlatformUpdate[] | null) {}
  async list() {
    this.lists++;
    return this.updates;
  }
  async resolve(
    _app: string,
    update: { id: string },
    outcome: 'merged' | 'conflicted'
  ): Promise<PlatformUpdateResolve> {
    this.resolved.push(`${update.id}:${outcome}`);
    if (this.updates)
      this.updates =
        outcome === 'merged'
          ? this.updates.filter((u) => u.id !== update.id)
          : this.updates.map((u) => (u.id === update.id ? { ...u, status: 'conflicted' } : u));
    return outcome === 'merged'
      ? { resolved: true, outcome, mergeCommitSha: 'c'.repeat(40) }
      : { resolved: true, outcome };
  }
}

const UPDATE: PendingPlatformUpdate = {
  id: 'apu_1',
  commitSha: 'a'.repeat(40),
  baseCommitSha: 'b'.repeat(40),
  reason: 'Fix the storage call',
  touchesManifest: false,
  status: 'pending',
  by: { username: 'CivitaiOfficial (App Assistant)' },
  verified: true,
  files: [{ path: 'src/a.ts', operation: 'update', base: 'a0\n', update: 'a1\n' }],
};

async function open(civitai: PlatformUpdateSource | undefined) {
  const tools = await new AppAssistantTools({
    sandboxUrl: fake.url,
    tokens: () => async (purpose) => `test-token-${purpose}`,
    log: quiet,
    wakePollMs: 5,
    wakeTimeoutMs: 5_000,
    ...(civitai ? { platformUpdates: () => civitai } : {}),
  }).open({
    userId: 'u-1',
    runId: 'run-1',
    conversationId: 'conv-1',
    page: { app: 'my-app' },
    history: chosenApp('my-app'),
    signal: new AbortController().signal,
  });
  opened.push(tools);
  return tools;
}

function call(tools: ToolSet, name: string, input: Record<string, unknown>) {
  const tool = tools[name];
  if (!tool?.execute) throw new Error(`no tool ${name}`);
  return Promise.resolve(
    tool.execute(input as never, { toolCallId: 't-1', messages: [] } as never)
  );
}

describe('platform updates as a reply opens', () => {
  it('a clean update is written and its lines reach the reply’s instructions', async () => {
    fake.add('my-app');
    files.set('my-app/src/a.ts', 'a0\n');
    const civitai = new Civitai([UPDATE]);
    const tools = await open(civitai);
    expect(files.get('my-app/src/a.ts')).toBe('a1\n');
    expect(civitai.resolved).toEqual(['apu_1:merged']);
    expect(tools.instructions).toContain(
      '["CivitaiOfficial (App Assistant) updated your app: Fix the storage call","Changed: src/a.ts"]'
    );
  });

  it('a conflict leaves the app’s file, and offers platform_update_merged, which records it merged', async () => {
    fake.add('my-app');
    files.set('my-app/src/a.ts', 'a-mine\n');
    const civitai = new Civitai([UPDATE]);
    const tools = await open(civitai);
    expect(files.get('my-app/src/a.ts')).toBe('a-mine\n');
    expect(files.get('my-app/scratch/platform-update-apu_1/update/src/a.ts')).toBe('a1\n');
    expect(files.get('my-app/scratch/platform-update-apu_1/base/src/a.ts')).toBe('a0\n');
    expect(tools.instructions).toContain('call platform_update_merged with { "id": "apu_1" }');
    expect(Object.keys(tools.tools)).toContain(PLATFORM_UPDATE_MERGED);
    await expect(call(tools.tools, PLATFORM_UPDATE_MERGED, { id: 'apu_1' })).resolves.toBe(
      'Saved, and recorded platform update apu_1 as merged (commit cccccccccccc).'
    );
    expect(civitai.resolved).toEqual(['apu_1:conflicted', 'apu_1:merged']);
  });

  it('a runner started after the hand-off rebuilds it from civitai’s open list, and records the merge', async () => {
    fake.add('my-app');
    files.set('my-app/src/a.ts', 'a-mine\n');
    // Handed over (and recorded conflicted) by an earlier runner; its scratch files are gone.
    const civitai = new Civitai([{ ...UPDATE, status: 'conflicted' }]);
    const tools = await open(civitai);
    expect(files.get('my-app/scratch/platform-update-apu_1/update/src/a.ts')).toBe('a1\n');
    expect(files.get('my-app/scratch/platform-update-apu_1/base/src/a.ts')).toBe('a0\n');
    expect(tools.instructions).toContain('call platform_update_merged with { "id": "apu_1" }');
    files.set('my-app/src/a.ts', 'a-mine\na1\n');
    await expect(call(tools.tools, PLATFORM_UPDATE_MERGED, { id: 'apu_1' })).resolves.toBe(
      'Saved, and recorded platform update apu_1 as merged (commit cccccccccccc).'
    );
    expect(civitai.resolved).toEqual(['apu_1:merged']);
  });

  it('platform_update_merged is offered with no hand-off at the reply’s start, for one a submit hands over', async () => {
    fake.add('my-app');
    files.set('my-app/src/a.ts', 'a-mine\n');
    const civitai = new Civitai([]);
    const tools = await open(civitai);
    expect(tools.instructions).not.toContain('platform update');
    expect(Object.keys(tools.tools)).toContain(PLATFORM_UPDATE_MERGED);
    // Staff pushed one mid-reply, and the submit's apply handed it over: the tool records it.
    civitai.updates = [{ ...UPDATE, status: 'conflicted' }];
    await expect(call(tools.tools, PLATFORM_UPDATE_MERGED, { id: 'apu_1' })).resolves.toBe(
      'Saved, and recorded platform update apu_1 as merged (commit cccccccccccc).'
    );
  });

  it('no platform-update source, or none pending: the reply opens as before', async () => {
    fake.add('my-app');
    files.set('my-app/src/a.ts', 'a0\n');
    const none = new Civitai(null);
    for (const civitai of [undefined, none]) {
      const tools = await open(civitai);
      expect(tools.instructions).not.toContain('platform update');
      // Offered only when platform updates are configured.
      expect(Object.keys(tools.tools).includes(PLATFORM_UPDATE_MERGED)).toBe(civitai !== undefined);
    }
    expect(none.lists).toBe(1);
    expect(files.get('my-app/src/a.ts')).toBe('a0\n');
    expect(fake.calls.filter((c) => c.tool === 'write_file')).toEqual([]);
  });
});
