import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLAIN_URL_FIELDS,
  stripPlainUrlFields,
} from '~/server/services/blocks/steps/plain-url-fields';
import { splitPassThroughStep } from '~/server/services/blocks/steps/output';

/** The orchestration client's generated types, as installed. */
function clientTypes(): string {
  const require = createRequire(import.meta.url);
  const entry = require.resolve('@civitai/orchestration-client');
  return readFileSync(join(dirname(entry), 'generated', 'types.gen.d.ts'), 'utf8');
}

/**
 * Every string, or string-array, field whose name says it carries a link, on every output,
 * result or epoch type the client declares.
 */
function urlFieldsInClientOutputs(source: string): string[] {
  const found: string[] = [];
  const typeBlock = /^export type (\w+) = (?:[^{\n]*& )?\{\n([\s\S]*?)^\};/gm;
  for (const [, name, body] of source.matchAll(typeBlock)) {
    if (!/(Output|Result|Epoch\w*)$/.test(name)) continue;
    for (const line of body.split('\n')) {
      const prop = line.match(/^ {2}(\w+)\??: (.*);$/);
      if (!prop) continue;
      const [, field, type] = prop;
      const isString = /\bstring\b/.test(type) && !/\{/.test(type);
      const linkName = /url|uri|href/i.test(field);
      const mediaList =
        /Array<string>/.test(type) && /(images|videos|audios|files|urls)$/i.test(field);
      if ((isString && linkName) || mediaList) found.push(`${name}.${field}`);
    }
  }
  return found.sort();
}

describe('every plain url field of an orchestrator output is classified', () => {
  const found = urlFieldsInClientOutputs(clientTypes());

  it('POSITIVE CONTROL: the walk finds the two fields known to carry a url as a plain string', () => {
    expect(found).toContain('BlobArchiveOutput.url');
    expect(found).toContain('EpochResult.blobUrl');
  });

  it('names every url field the client declares', () => {
    const unclassified = found.filter((field) => !(field in PLAIN_URL_FIELDS));
    expect(unclassified).toStrictEqual([]);
  });

  it('names no field the client no longer declares', () => {
    const stale = Object.keys(PLAIN_URL_FIELDS).filter((field) => !found.includes(field));
    expect(stale).toStrictEqual([]);
  });
});

describe('what reaches the app', () => {
  const ARCHIVE_URL = 'https://orch.example/v2/consumer/blobs/ARCHIVE.zip';

  it('a blob archive keeps its entry count and format, never its url', () => {
    const { rest, media } = splitPassThroughStep('blobArchive', {
      url: ARCHIVE_URL,
      entryCount: 3,
      format: 'zip',
    });
    expect(rest).toStrictEqual({ entryCount: 3, format: 'zip' });
    expect(media).toStrictEqual([]);
    expect(JSON.stringify(rest)).not.toContain('ARCHIVE');
  });

  it('the $type match ignores case, as the orchestrator echo may not', () => {
    expect(stripPlainUrlFields('BlobArchive', { url: ARCHIVE_URL })).toStrictEqual({});
  });

  it("a custom comfy run's trace url is stripped", () => {
    expect(stripPlainUrlFields('customComfy', { traceUrl: 'https://t.example/x', ok: 1 })).toEqual({
      ok: 1,
    });
  });

  it("an image training run's selected input images are stripped", () => {
    const { rest } = splitPassThroughStep('imageResourceTraining', {
      sampleInputImages: ['https://orch.example/in1.png'],
      epochs: [],
    });
    expect(JSON.stringify(rest)).not.toContain('in1.png');
  });

  it('a transcode result is lifted whole: no public url survives in what is forwarded', () => {
    const { rest } = splitPassThroughStep('transcode', {
      id: 'T1',
      url: 'https://orch.example/v2/consumer/blobs/T1.mp4',
      publicUrl: 'https://public.example/T1.mp4',
      urlExpiresAt: '2026-11-17T00:00:00Z',
      available: true,
      type: 'video',
    });
    expect(JSON.stringify(rest ?? null)).not.toContain('public.example');
  });

  it('CONTROL: a live speech session keeps the channels the app drives', () => {
    const live = {
      inputUrl: 'https://live.example/in',
      socketUrl: 'wss://live.example/s',
      audioUrl: 'https://live.example/a',
    };
    expect(stripPlainUrlFields('liveTextToSpeech', live)).toStrictEqual(live);
  });
});
