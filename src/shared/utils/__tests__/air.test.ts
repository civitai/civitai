import { describe, it, expect } from 'vitest';
import { getAirModelLink, getCivitaiAirModelLink } from '~/shared/utils/air';

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
