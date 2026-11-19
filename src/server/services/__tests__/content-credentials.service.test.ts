import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  declaresAiSource,
  readContentCredentials,
} from '~/server/services/content-credentials.service';

// CA.jpg is c2pa-rs's test fixture (sdk/tests/fixtures), signed with the C2PA test certificate.
const signed = readFileSync(path.join(__dirname, 'fixtures/c2pa/CA.jpg'));

// Drops every APP11 segment, where JPEG carries the C2PA manifest: what a re-encode or a
// metadata stripper leaves.
function stripManifest(jpeg: Buffer) {
  const kept = [jpeg.subarray(0, 2)];
  let i = 2;
  while (jpeg[i] === 0xff && jpeg[i + 1] !== 0xda) {
    const end = i + 2 + jpeg.readUInt16BE(i + 2);
    if (jpeg[i + 1] !== 0xeb) kept.push(jpeg.subarray(i, end));
    i = end;
  }
  kept.push(jpeg.subarray(i));
  return Buffer.concat(kept);
}

describe('readContentCredentials', () => {
  it('reads a signed file as valid, naming its signer', async () => {
    expect(await readContentCredentials(signed, 'image/jpeg')).toEqual({
      credentials: 'valid',
      signer: {
        issuer: 'C2PA Test Signing Cert',
        commonName: 'C2PA Signer',
        signedAt: expect.any(String),
      },
      generator: expect.any(String),
      aiGenerated: false,
    });
  });

  it('reports a stripped copy as having no credentials', async () => {
    const stripped = stripManifest(signed);
    expect(stripped.length).toBeLessThan(signed.length);
    expect(await readContentCredentials(stripped, 'image/jpeg')).toEqual({ credentials: 'none' });
  });

  it('reports pixels changed after signing as invalid', async () => {
    const tampered = Buffer.from(signed);
    tampered[tampered.length - 500] ^= 0xff;
    expect(await readContentCredentials(tampered, 'image/jpeg')).toMatchObject({
      credentials: 'invalid',
    });
  });
});

describe('declaresAiSource', () => {
  it('detects the IPTC AI source type on a c2pa.actions assertion', () => {
    const ai = 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia';
    const camera = 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCapture';
    const actions = (digitalSourceType: string) => [
      { label: 'c2pa.actions.v2', data: { actions: [{ digitalSourceType }] } },
    ];
    expect(declaresAiSource(actions(ai))).toBe(true);
    expect(declaresAiSource(actions(camera))).toBe(false);
  });
});
