import type { TypographyStylesProviderProps } from '@mantine/core';
import { useComputedColorScheme, lighten, darken } from '@mantine/core';
import { useMemo } from 'react';

import { needsColorSwap } from '~/utils/html-helpers';
import { DEFAULT_ALLOWED_ATTRIBUTES, sanitizeHtml } from '~/utils/html-sanitize-helpers';
import classes from './RenderHtml.module.scss';
import { TypographyStylesWrapper } from '~/components/TypographyStylesWrapper/TypographyStylesWrapper';
import clsx from 'clsx';
import { createProfanityFilter } from '~/libs/profanity-simple';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';

export function RenderHtml({
  html,
  withMentions = false,
  allowCustomStyles = true,
  withProfanityFilter = false,
  className,
  ...props
}: Props) {
  const colorScheme = useComputedColorScheme('dark');
  const blurNsfw = useBrowsingSettings((state) => state.blurNsfw);

  html = useMemo(() => {
    // Apply profanity filtering if enabled, but skip mentions
    let processedHtml = html;
    if (withProfanityFilter && blurNsfw) {
      const profanityFilter = createProfanityFilter();

      // Use regex to find and preserve mentions while filtering everything else
      const mentionRegex = /<span[^>]*data-type="mention"[^>]*>.*?<\/span>/gi;
      const mentions: string[] = [];
      let mentionIndex = 0;

      // Extract mentions and replace with placeholders
      processedHtml = processedHtml.replace(mentionRegex, (match) => {
        mentions.push(match);
        return `__MENTION_PLACEHOLDER_${mentionIndex++}__`;
      });

      // Apply profanity filtering to the text without mentions
      processedHtml = profanityFilter.clean(processedHtml);

      // Restore mentions
      mentions.forEach((mention, index) => {
        processedHtml = processedHtml.replace(`__MENTION_PLACEHOLDER_${index}__`, mention);
      });
    }

    return sanitizeHtml(processedHtml, {
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
    });
  }, [html, blurNsfw, allowCustomStyles, colorScheme, withMentions, withProfanityFilter]);

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
  withProfanityFilter?: boolean;
};
