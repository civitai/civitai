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
 * the reply's instructions, and a conflict offers `platform_update_merged`, which reports back.
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
    const match = /\[ -e '([^']+)' \]/.exec(String(args.command));
    const there = match ? files.has(match[1]) : false;
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
  constructor(readonly updates: PendingPlatformUpdate[] | null) {}
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
  by: { username: 'staffer' },
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
      'staffer (verified Civitai staff) updated your app: Fix the storage call\nChanged: src/a.ts'
    );
    expect(Object.keys(tools.tools)).not.toContain(PLATFORM_UPDATE_MERGED);
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

  it('no platform-update source, or none pending: the reply opens as before', async () => {
    fake.add('my-app');
    files.set('my-app/src/a.ts', 'a0\n');
    const none = new Civitai(null);
    for (const civitai of [undefined, none]) {
      const tools = await open(civitai);
      expect(tools.instructions).not.toContain('platform update');
      expect(Object.keys(tools.tools)).not.toContain(PLATFORM_UPDATE_MERGED);
    }
    expect(none.lists).toBe(1);
    expect(files.get('my-app/src/a.ts')).toBe('a0\n');
    expect(fake.calls.filter((c) => c.tool === 'write_file')).toEqual([]);
  });
});
