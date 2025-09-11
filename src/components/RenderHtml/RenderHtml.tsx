import type { TypographyStylesProviderProps } from '@mantine/core';
import { useComputedColorScheme, lighten, darken } from '@mantine/core';
import { useMemo } from 'react';

import { needsColorSwap } from '~/utils/html-helpers';
import { DEFAULT_ALLOWED_ATTRIBUTES, sanitizeHtml } from '~/utils/html-sanitize-helpers';
import classes from './RenderHtml.module.scss';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import clsx from 'clsx';

export function RenderHtml({
  html,
  withMentions = false,
  allowCustomStyles = true,
  className,
  ...props
}: Props) {
  const colorScheme = useComputedColorScheme('dark');

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
              ? needsColorSwap({
                  hexColor,
                  colorScheme,
                  threshold: 0.2,
                })
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
                            colorScheme === 'dark' ? lighten(hexColor, 0.5) : darken(hexColor, 0.3)
                          }`
                        : style,
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
    [html, withMentions, colorScheme]
  );

  return (
    <TypographyStylesWrapper {...props} className={clsx(classes.htmlRenderer, className)}>
      <div dangerouslySetInnerHTML={{ __html: html }} />
    </TypographyStylesWrapper>
  );
}

type Props = Omit<TypographyStylesProviderProps, 'children'> & {
  html: string;
  withMentions?: boolean;
  allowCustomStyles?: boolean;
};
