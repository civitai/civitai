import { CustomHeading } from './custom-heading.node';
import StarterKit from '@tiptap/starter-kit';
import Mention from '@tiptap/extension-mention';
import { TextStyleKit } from '@tiptap/extension-text-style';
import ImageExtension from '@tiptap/extension-image';
import { Instagram } from '~/libs/tiptap/extensions/Instagram';
import { StrawPoll } from '~/libs/tiptap/extensions/StrawPoll';
import { EdgeMediaNode } from '~/shared/tiptap/edge-media.node';
import { CustomYoutubeNode } from '~/shared/tiptap/custom-youtube-node';

export const tiptapExtensions = [
  StarterKit.configure({ heading: false }),
  CustomHeading,
  TextStyleKit,
  EdgeMediaNode,
  ImageExtension,
  CustomYoutubeNode,
  Instagram,
  Mention,
  StrawPoll,
];
