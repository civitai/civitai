import {
  createStyles,
  TypographyStylesProvider,
  TypographyStylesProviderProps,
} from '@mantine/core';
import { useMemo } from 'react';

import { needsColorSwap, sanitizeHtml } from '~/utils/html-helpers';

const useStyles = createStyles((theme) => ({
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
    'div[data-type="instagram"]': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      height: 769,

      '& > iframe': {
        width: '50%',
        overflow: 'hidden',
        flexGrow: 1,
      },

      [theme.fn.smallerThan('md')]: {
        height: 649,
      },

      [theme.fn.smallerThan('sm')]: {
        height: 681,

        '& > iframe': {
          width: '100%',
        },
      },
    },
    'div[data-type="strawPoll"]': {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      height: 480,

      '& > iframe': {
        flexGrow: 1,
      },
    },
    // Prevent heading to be hidden by the fixed navbar
    'h1, h2, h3': {
      '&:before': {
        display: 'block',
        content: '""',
        // Navbar height + margin
        marginTop: theme.spacing.xs * -7,
        height: theme.spacing.xs * 7 + theme.spacing.xs,
        visibility: 'hidden',
      },
    },
  },
}));

export function RenderHtml({ html, withMentions = false, ...props }: Props) {
  const { classes, theme } = useStyles();

  html = useMemo(
    () =>
      sanitizeHtml(html, {
        transformTags: {
          span: function (tagName, attribs) {
            const dataType = attribs['data-type'];
            const isMention = dataType === 'mention';
            const style = attribs['style'];
            const hexColor = style?.match(/color:#([0-9a-f]{6})/)?.[1];
            const needsSwap = hexColor
              ? needsColorSwap({ hexColor, colorScheme: theme.colorScheme, threshold: 0.2 })
              : false;

            return withMentions && isMention
              ? {
                  tagName: 'a',
                  attribs: {
                    ...attribs,
                    href: `/user/${attribs['data-label'] ?? attribs['data-id']}`,
                  },
                }
              : {
                  tagName,
                  attribs: {
                    ...attribs,
                    style:
                      needsSwap && hexColor
                        ? style +
                          `;color:${
                            theme.colorScheme === 'dark'
                              ? theme.fn.lighten(hexColor, 0.5)
                              : theme.fn.darken(hexColor, 0.3)
                          }`
                        : style,
                  },
                };
          },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, withMentions, theme.colorScheme]
  );

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
