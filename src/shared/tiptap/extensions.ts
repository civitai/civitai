import { CustomHeading } from './custom-heading.node';
import StarterKit from '@tiptap/starter-kit';
import Mention from '@tiptap/extension-mention';
import { TextStyleKit } from '@tiptap/extension-text-style';
import { Instagram } from '~/libs/tiptap/extensions/Instagram';
import { StrawPoll } from '~/libs/tiptap/extensions/StrawPoll';
import { EdgeMediaNode } from '~/shared/tiptap/edge-media.node';
import { CustomYoutubeNode } from '~/shared/tiptap/custom-youtube-node';
import { TimestampNode } from '~/shared/tiptap/timestamp.node';
import { BlurbNode } from '~/shared/tiptap/blurb.node';
import { EmbedNode } from '~/shared/tiptap/embed.node';
import { SizedImage } from '~/shared/tiptap/sized-image.node';
import { TextAlignExtension } from '~/shared/tiptap/text-align';
import { CivitaiEmbedNode } from '~/shared/tiptap/civitai-embed.node';
import { SpoilerBlockNode, SpoilerMark } from '~/shared/tiptap/spoiler.node';

export const tiptapExtensions = [
  StarterKit.configure({ heading: false }),
  CustomHeading,
  TextStyleKit,
  EdgeMediaNode,
  SizedImage,
  CustomYoutubeNode,
  Instagram,
  Mention,
  StrawPoll,
  TimestampNode,
  BlurbNode,
  EmbedNode,
  TextAlignExtension,
  CivitaiEmbedNode,
  SpoilerMark,
  SpoilerBlockNode,
];
