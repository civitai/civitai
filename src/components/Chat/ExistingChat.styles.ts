import { CSSObject } from '@mantine/styles';

export const styles: Record<string, CSSObject> = {
  chatMessage: {
    borderRadius: 'var(--mantine-spacing-xs)',
    padding: 'calc(var(--mantine-spacing-xs) / 2) var(--mantine-spacing-xs)',
    width: 'max-content',
    maxWidth: '70%',
    whiteSpace: 'pre-line',
  },
  replyMessage: {
    textOverflow: 'ellipsis',
    overflow: 'hidden',
    overflowWrap: 'normal',
    backgroundColor: 'var(--mantine-color-dark-7)',
    fontSize: 'var(--mantine-spacing-sm)',
  },
  myDetails: {
    flexDirection: 'row-reverse',
  },
  myMessage: {
    backgroundColor: 'var(--mantine-color-blue-8)',
  },
  otherMessage: {
    backgroundColor: 'var(--mantine-color-dark-3)',
  },
  highlightRow: {
    '&:hover': {
      '> button': {
        display: 'initial',
      },
    },
  },
  chatInput: {
    borderRadius: 0,
    borderLeft: 0,
    borderTop: 0,
    borderBottom: 0,
  },
  isTypingBox: {
    position: 'sticky',
    bottom: 0,
    display: 'inline-flex',
  },
};
