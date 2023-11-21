import { createStyles } from '@mantine/core';
import { containerQuery } from '~/utils/mantine-css-helpers';

export const useHomeBlockStyles = createStyles((theme, _, getRef) => {
  const expandButtonRef = getRef('expandButton');
  return {
    title: {
      fontSize: 32,

      [containerQuery.smallerThan('sm')]: {
        fontSize: 24,
      },
    },

    expandButton: {
      ref: expandButtonRef,
      height: 34,
    },

    header: {
      [containerQuery.smallerThan('sm')]: {
        display: 'block',
        [`& .${expandButtonRef}`]: {
          paddingLeft: 0,
          paddingRight: 0,
        },
      },
    },
  };
});
