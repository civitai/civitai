import {
  createStyles,
  TypographyStylesProvider,
  TypographyStylesProviderProps,
} from '@mantine/core';
import React from 'react';

import { sanitizeHtml } from '~/utils/html-helpers';

const useStyles = createStyles(() => ({
  htmlRenderer: {
    '& p:last-of-type': {
      marginBottom: 0,
    },
    p: {
      wordBreak: 'break-word',
    },
    iframe: {
      border: 'none',
    },
    // pre: {
    //   whiteSpace: 'pre',
    //   wordWrap: 'normal',
    //   overflowX: 'auto',
    // },
    code: {
      // whiteSpace: 'pre-line',
      whiteSpace: 'break-spaces',
    },
  },
}));

export function RenderHtml({ html, withMentions = false, ...props }: Props) {
  const { classes } = useStyles();

  if (withMentions) {
    html = sanitizeHtml(html, {
      transformTags: {
        span: function (tagName, attribs) {
          const dataType = attribs['data-type'];
          const isMention = dataType === 'mention';

          return isMention
            ? {
                tagName: 'a',
                attribs: {
                  ...attribs,
                  href: `/user/${attribs['data-label'] ?? attribs['data-id']}`,
                },
              }
            : { tagName, attribs };
        },
      },
    });
  }

  return (
    <TypographyStylesProvider {...props} className={classes.htmlRenderer}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesProvider>
  );
}

type Props = Omit<TypographyStylesProviderProps, 'children'> & {
  html: string;
  withMentions?: boolean;
};
