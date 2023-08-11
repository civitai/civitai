import { createStyles } from '@mantine/core';

export const useHomeBlockStyles = createStyles((theme, _, getRef) => {
  const expandButtonRef = getRef('expandButton');
  return {
    title: {
      fontSize: 32,

      [theme.fn.smallerThan('sm')]: {
        fontSize: 24,
      },
    },

    expandButton: {
      ref: expandButtonRef,
      height: 34,
    },

    header: {
      [theme.fn.smallerThan('sm')]: {
        display: 'block',
        [`& .${expandButtonRef}`]: {
          paddingLeft: 0,
          paddingRight: 0,
        },
      },
    },
  };
});
