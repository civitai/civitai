import { afterEach, describe, expect, it } from 'vitest';
import {
  buildProbeWorkflow,
  isSystemAccountWorkflow,
  probeMediaUrl,
  projectScanSignals,
  readVerdict,
  tripsBreaker,
} from '../scan-probe/workflow';

const BASE = 'https://image.example.test/acct';

const keysAtAnyDepth = (value: unknown, out = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => keysAtAnyDepth(v, out));
  else if (value && typeof value === 'object')
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysAtAnyDepth(v, out);
    }
  return out;
};

// Decision, not an omission: the main app's scan-result webhook only runs on a callback and only
// writes when `metadata.imageId` is set. Ingestion's builder sets both; this one must never.
describe('buildProbeWorkflow: nothing that lets ingestion process the result', () => {
  const body = buildProbeWorkflow(`${BASE}/key/original=true/key.jpeg`);

  it('has no callbacks and no metadata at any depth', () => {
    const keys = keysAtAnyDepth(body);
    expect(keys.has('callbacks')).toBe(false);
    expect(keys.has('metadata')).toBe(false);
  });

  it('spends no Buzz and runs one imageScanning step on the given url', () => {
    expect(body.currencies).toEqual([]);
    expect(body.steps).toEqual([
      expect.objectContaining({
        $type: 'imageScanning',
        input: { image: `${BASE}/key/original=true/key.jpeg` },
      }),
    ]);
  });
});

describe('probeMediaUrl: only relative keys, only onto the image origin', () => {
  afterEach(() => {
    delete process.env.PUBLIC_IMAGE_LOCATION;
  });

  it('builds a delivery url on the configured origin for a plain key', () => {
    process.env.PUBLIC_IMAGE_LOCATION = BASE;
    expect(probeMediaUrl('0b7c9e1a-1111-2222-3333-444455556666')).toMatch(
      new RegExp(`^${BASE}/0b7c9e1a-1111-2222-3333-444455556666/`)
    );
  });

  it.each([
    ['an absolute url', 'https://evil.example/x.png'],
    ['a protocol-relative url', '//evil.example/x.png'],
    ['a scheme without slashes', 'http:evil.example/x'],
    ['a blob url', 'blob:https://image.example.test/x'],
    ['a backslash', 'key\\@127.0.0.1/x'],
    ['a leading space', ' //evil.example/x'],
    ['a leading slash', '/etc/passwd'],
    ['an empty key', ''],
    ['a dot segment', 'a/../../cdn-cgi/image/w=1/x'],
    ['a lone dot segment', './x'],
    ['an embedded url', 'a/https://evil.example/x'],
  ])('refuses %s', (_label, key) => {
    process.env.PUBLIC_IMAGE_LOCATION = BASE;
    expect(probeMediaUrl(key)).toBeNull();
  });

  it('refuses everything when the image origin is unset or not https', () => {
    expect(probeMediaUrl('abc')).toBeNull();
    process.env.PUBLIC_IMAGE_LOCATION = 'http://image.example.test/acct';
    expect(probeMediaUrl('abc')).toBeNull();
  });
});

const MASK = 'iVBORw0KGgo' + 'A'.repeat(4000);
const BLOB_URL = 'https://orchestrator.example.test/v2/consumer/blobs/abc123';

const rawSteps = (output: Record<string, unknown>) => [
  { $type: 'imageScanning', name: 'scan', input: { image: BLOB_URL }, output },
];

const fullOutput = {
  nsfwLevel: 'pg13',
  score: 0.42,
  csam: false,
  blockedReason: null,
  aiRecognition: { label: 'ai', score: 0.9, topK: [{ label: 'x', score: 1 }] },
  animeRecognition: { label: 'real', score: 0.8 },
  humanRecognition: {
    label: 'human',
    score: 0.7,
    humanScore: 0.7,
    noHumanScore: 0.3,
    evidence: [],
  },
  jointAgeClassification: {
    status: 'ok',
    ran: true,
    childDetected: false,
    minorDetected: false,
    oodDetected: false,
    detections: [
      {
        boundingBox: [1, 2, 3, 4],
        domain: 'real',
        apparentAge: 30.2,
        ageBand: 'adult',
        under13Probability: 0.01,
        under18Probability: 0.02,
        isChild: false,
        isMinor: false,
        isOod: false,
        personMask: { width: 64, height: 64, pngBase64: MASK },
      },
    ],
  },
  tagging: { ran: true, tags: [{ tag: 'outdoors', category: 'general', score: 0.6 }] },
};

describe('projectScanSignals: signals only, never image bytes or urls', () => {
  it('drops the person mask, the bounding boxes and every url', () => {
    const projected = projectScanSignals(rawSteps(fullOutput));
    const serialised = JSON.stringify(projected);
    expect(serialised).not.toContain('pngBase64');
    expect(serialised).not.toContain(MASK.slice(0, 20));
    expect(serialised).not.toContain('boundingBox');
    expect(serialised).not.toContain('://');
    expect(projected?.age?.detections[0]).toMatchObject({
      ageBand: 'adult',
      under18Probability: 0.02,
    });
    expect(projected?.tags).toEqual([{ tag: 'outdoors', category: 'general', score: 0.6 }]);
  });

  it('drops a string field that carries a url', () => {
    const projected = projectScanSignals(
      rawSteps({ ...fullOutput, blockedReason: `see ${BLOB_URL}` })
    );
    expect(projected?.blockedReason).toBeNull();
  });

  it('is null when there is no scan output', () => {
    expect(projectScanSignals([{ $type: 'imageScanning' }])).toBeNull();
    expect(projectScanSignals(undefined)).toBeNull();
  });
});

describe('tripsBreaker: any block, any CSAM flag, any unclean finish', () => {
  const clean = readVerdict(rawSteps(fullOutput));

  it('does not trip on a clean success', () => {
    expect(tripsBreaker('succeeded', clean)).toBe(false);
  });

  it.each([
    ['a CSAM flag', 'succeeded', { ...fullOutput, csam: true }],
    ['a blocked reason', 'succeeded', { ...fullOutput, blockedReason: 'anything' }],
    ['a failed workflow', 'failed', fullOutput],
    ['an expired workflow', 'expired', fullOutput],
    ['a canceled workflow', 'canceled', fullOutput],
  ])('trips on %s', (_label, status, output) => {
    expect(tripsBreaker(status, readVerdict(rawSteps(output)))).toBe(true);
  });

  it('trips on a success with no output', () => {
    expect(tripsBreaker('succeeded', null)).toBe(true);
  });
});

describe('isSystemAccountWorkflow', () => {
  it('accepts only ids prefixed with user 0', () => {
    expect(isSystemAccountWorkflow('0-20261023-abc')).toBe(true);
    expect(isSystemAccountWorkflow('5-20261023-abc')).toBe(false);
    expect(isSystemAccountWorkflow('10-20261023-abc')).toBe(false);
  });
});
