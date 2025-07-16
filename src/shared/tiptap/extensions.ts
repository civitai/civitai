import { CustomHeading } from './custom-heading.node';
import StarterKit from '@tiptap/starter-kit';
import { Color } from '@tiptap/extension-color';
import Heading from '@tiptap/extension-heading';
import Mention from '@tiptap/extension-mention';
import { TextStyleKit } from '@tiptap/extension-text-style';
import ImageExtension from '@tiptap/extension-image';
import { Instagram } from '~/libs/tiptap/extensions/Instagram';
import { StrawPoll } from '~/libs/tiptap/extensions/StrawPoll';
import Youtube from '@tiptap/extension-youtube';
import { EdgeMediaNode } from '~/shared/tiptap/edge-media.node';

export const tiptapExtensions = [
  StarterKit.configure({ heading: false }),
  CustomHeading,
  TextStyleKit,
  EdgeMediaNode,
  ImageExtension,
  Youtube,
  Instagram,
  Mention,
  StrawPoll,
];
