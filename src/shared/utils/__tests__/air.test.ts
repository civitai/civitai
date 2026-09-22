import { describe, it, expect } from 'vitest';
import {
  getAirModelLink,
  getCivitaiAirModelLink,
  rawAirResourceId,
  versionIdFromAir,
} from '~/shared/utils/air';

describe('rawAirResourceId', () => {
  it('is negative, nonzero, and deterministic', () => {
    const air = 'urn:air:sdxl:lora:orchestrator:blob@somekey';
    expect(rawAirResourceId(air)).toBeLessThan(0);
    expect(rawAirResourceId(air)).toBe(rawAirResourceId(air));
    expect(rawAirResourceId('')).toBeLessThan(0);
  });
});

describe('getCivitaiAirModelLink', () => {
  it('links to the model page for a civitai checkpoint AIR', () => {
    expect(getCivitaiAirModelLink('urn:air:flux1:checkpoint:civitai:618692@691639')).toBe(
      '/models/618692?modelVersionId=691639'
    );
  });

  it('returns null for a HuggingFace AIR (string id segments would be NaN)', () => {
    expect(
      getCivitaiAirModelLink(
        'urn:air:wanvideo:vae:huggingface:Wan-AI/Wan2.1-I2V-14B-720P@main/Wan2.1_VAE.pth'
      )
    ).toBeNull();
    expect(
      getCivitaiAirModelLink(
        'urn:air:hyv1:vae:huggingface:tencent/HunyuanVideo@main/hunyuan-video-t2v-720p/vae/pytorch_model.pt'
      )
    ).toBeNull();
  });

  it('returns null for a non-civitai AIR even when its id segment is numeric', () => {
    // Guards the `source !== 'civitai'` clause on its own: a numeric id here would
    // otherwise mint a bogus /models/<n> link to an unrelated civitai model.
    expect(getCivitaiAirModelLink('urn:air:sd1:checkpoint:huggingface:12345@678')).toBeNull();
  });

  it('returns null for a civitai AIR with no version (would be NaN in the query)', () => {
    expect(getCivitaiAirModelLink('urn:air:flux1:checkpoint:civitai:618692')).toBeNull();
  });

  it('returns null for an unparseable identifier', () => {
    expect(getCivitaiAirModelLink('not-an-air')).toBeNull();
  });
});

describe('getAirModelLink', () => {
  it('never emits a NaN link for a HuggingFace base-model AIR', () => {
    const link = getAirModelLink(
      'urn:air:wanvideo:vae:huggingface:Wan-AI/Wan2.1-I2V-14B-720P@main/Wan2.1_VAE.pth'
    );
    expect(link).not.toContain('NaN');
    expect(link).toBe('/');
  });

  it('resolves a civitai AIR to its model page', () => {
    expect(getAirModelLink('urn:air:flux1:checkpoint:civitai:618692@691639')).toBe(
      '/models/618692?modelVersionId=691639'
    );
  });
});

describe('versionIdFromAir', () => {
  it('resolves a civitai AIR to its version id', () => {
    expect(versionIdFromAir('urn:air:flux1:checkpoint:civitai:618692@691639')).toBe(691639);
  });

  // The same version appears both with and without a file id; both must land on one row.
  it('resolves a civitai AIR carrying a file id to the same version', () => {
    expect(versionIdFromAir('urn:air:sdxl:checkpoint:civitai:1224788@2467972+2356618')).toBe(
      2467972
    );
  });

  // The source guard on its own: another source's version segment can be a bare integer, and would
  // otherwise resolve to an unrelated ModelVersion.
  it.each([
    ['a HuggingFace AIR', 'urn:air:sd1:checkpoint:huggingface:12345@678'],
    ['an orchestrator blob', 'urn:air:sdxl:lora:orchestrator:blob@12345'],
    ['an OCI image', 'urn:air:oci:image:dockerhub:vllm/vllm-openai@26'],
  ])('rejects %s whose version segment is numeric', (_, air) => {
    expect(versionIdFromAir(air)).toBeUndefined();
  });

  it('rejects a civitai AIR naming no version', () => {
    expect(versionIdFromAir('urn:air:flux1:checkpoint:civitai:618692')).toBeUndefined();
  });

  it('rejects something that is not an AIR', () => {
    expect(versionIdFromAir('not-an-air')).toBeUndefined();
  });
});
