import { Instagram } from '~/libs/tiptap/extensions/Instagram';
import classes from './InstagramNode.module.scss';

export const InstagramNode = Instagram.configure({
  HTMLAttributes: { class: classes.instagramEmbed },
  height: 'auto',
});
