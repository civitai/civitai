import Mention from '@tiptap/extension-mention';
import classes from './MentionNode.module.scss';

export const MentionNode = Mention.configure({
  HTMLAttributes: {
    class: classes.mention,
  },
  renderText({ options, node }) {
    const label = node.attrs.label ?? node.attrs.id;
    return `${options.suggestion.char ?? ''}${typeof label === 'string' ? label : ''}`;
  },
});
