import { describe, expect, it } from 'vitest';
import {
  collectWorkflowEvidence,
  parseOrchestratorBlobKey,
} from '~/server/services/generator-evidence/evidence-refs';

/** Which strings in a workflow or trigger name one of our orchestrator's blobs. Values are invented. */

const ORIGIN = 'https://orchestrator.example.invalid';

describe('parseOrchestratorBlobKey', () => {
  it.each([
    [`${ORIGIN}/v2/consumer/blobs/KEY0001.png?sig=x`, 'KEY0001.png'],
    ['https://orchestration.civitai.com/v2/consumer/blobs/KEY0002.jpeg', 'KEY0002.jpeg'],
    ['urn:air:other:other:orchestrator:blob@KEY0003.webp', 'KEY0003.webp'],
  ])('reads the key from %s', (value, key) => {
    expect(parseOrchestratorBlobKey(value, ORIGIN)).toBe(key);
  });

  it.each([
    'https://attacker.example.invalid/v2/consumer/blobs/KEY0001.png',
    `${ORIGIN}/v2/consumer/blobs/content/token`,
    `${ORIGIN}/v2/consumer/blobs/upload`,
    `${ORIGIN}/v2/consumer/blobs/%ZZ`,
    'a prompt that is not a url',
  ])('names no blob for %s', (value) => {
    expect(parseOrchestratorBlobKey(value, ORIGIN)).toBeNull();
  });
});

describe('collectWorkflowEvidence', () => {
  it('does not fail a workflow over a malformed string in its input', () => {
    const job = collectWorkflowEvidence(
      {
        id: '7-20261101000000000000',
        steps: [{ name: 's', input: { prompt: `${ORIGIN}/v2/consumer/blobs/%ZZ` }, output: {} }],
      },
      ORIGIN
    );
    expect(job?.refs).toEqual([]);
  });
});
