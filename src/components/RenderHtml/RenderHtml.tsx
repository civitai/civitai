import { TypographyStylesProvider, TypographyStylesProviderProps } from '@mantine/core';
import { createStyles } from '@mantine/styles';
import { useMemo } from 'react';

import { DEFAULT_ALLOWED_ATTRIBUTES, needsColorSwap, sanitizeHtml } from '~/utils/html-helpers';
import { styles } from './RenderHtml.styles';

const useStyles = createStyles(styles);

export function RenderHtml({
  html,
  withMentions = false,
  allowCustomStyles = true,
  ...props
}: Props) {
  const { classes } = useStyles();

  html = useMemo(
    () =>
      sanitizeHtml(html, {
        parseStyleAttributes: allowCustomStyles,
        allowedAttributes: {
          ...DEFAULT_ALLOWED_ATTRIBUTES,
          div: ['data-youtube-video', 'data-type', 'style'],
        },
        allowedStyles: allowCustomStyles
          ? {
              div: { height: [/^\d+px$/] },
            }
          : undefined,
        transformTags: {
          div: function (tagName, attribs) {
            if (attribs['data-type'] !== 'strawPoll') delete attribs.style;
            return {
              tagName,
              attribs,
            };
          },
          span: function (tagName, attribs) {
            const dataType = attribs['data-type'];
            const isMention = dataType === 'mention';
            const style = attribs['style'];
            let hexColor = style?.match(/color:#([0-9a-f]{6})/)?.[1];
            const [, r, g, b] = style?.match(/color:rgba?\((\d+), (\d+), (\d+),? ?(\d+)?\)/) ?? [];
            const rgbColors = [r, g, b]
              .map((color) => {
                const value = parseInt(color, 10);
                if (isNaN(value)) return '';
                return value.toString(16).padStart(2, '0');
              })
              .filter(Boolean);

            if (rgbColors.length === 3) hexColor = rgbColors.join('');

            const needsSwap = hexColor
              ? needsColorSwap({ hexColor, colorScheme: 'dark', threshold: 0.2 })
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
                      needsSwap && hexColor ? style + `;color:var(--mantine-color-dark-4)` : style,
                  },
                };
          },
          a: function (tagName, attribs) {
            if (typeof window !== 'undefined' && attribs.href)
              attribs.href = attribs.href.replace('//civitai.com', `//${location.host}`);

            return {
              tagName,
              attribs,
            };
          },
        },
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [html, withMentions]
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
  allowCustomStyles?: boolean;
};
