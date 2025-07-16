import { StrawPoll } from '~/libs/tiptap/extensions/StrawPoll';
import classes from './StrawPollNode.module.scss';

export const StrawPollNode = StrawPoll.configure({
  HTMLAttributes: { class: classes.strawPollEmbed },
  height: 'auto',
});
