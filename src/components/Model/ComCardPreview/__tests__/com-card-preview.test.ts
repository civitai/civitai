import { describe, expect, it } from 'vitest';
import {
  canLinkToRedCard,
  canPreviewComCard,
  withComCard,
} from '~/components/Model/ComCardPreview/com-card-preview';

const viewer = { isOwnerOrModerator: false, onComSite: false };
const ownerOrMod = { isOwnerOrModerator: true, onComSite: false };

describe('civitai.com card preview', () => {
  it('never offers a viewer who is neither owner nor moderator the toggle or the link', () => {
    for (const onComSite of [false, true]) {
      expect(canPreviewComCard({ ...viewer, onComSite }, 'Com title')).toBe(false);
      expect(canLinkToRedCard({ ...viewer, onComSite }, 'Com title')).toBe(false);
    }
  });

  it('offers the owner or a moderator the toggle on civitai.red and the link on civitai.com', () => {
    expect(canPreviewComCard(ownerOrMod, 'Com title')).toBe(true);
    expect(canLinkToRedCard(ownerOrMod, 'Com title')).toBe(false);
    expect(canPreviewComCard({ ...ownerOrMod, onComSite: true }, 'Com title')).toBe(false);
    expect(canLinkToRedCard({ ...ownerOrMod, onComSite: true }, 'Com title')).toBe(true);
  });

  it('offers neither on a model with no civitai.com card', () => {
    expect(canPreviewComCard(ownerOrMod, null)).toBe(false);
    expect(canLinkToRedCard({ ...ownerOrMod, onComSite: true }, null)).toBe(false);
  });

  it('previews the civitai.com title and description, with no version descriptions', () => {
    const model = {
      name: 'Red title',
      description: '<p>Red</p>',
      sfwName: 'Com title',
      sfwDescription: null,
      modelVersions: [{ id: 1, description: '<p>v1</p>' }],
    };
    const previewed = withComCard(model);
    expect(previewed.name).toBe('Com title');
    expect(previewed.description).toBeNull();
    expect(previewed.modelVersions[0].description).toBeNull();
    expect(model.name).toBe('Red title');
  });
});
