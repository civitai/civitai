import React, { forwardRef } from 'react';
import type { TextProps } from '@mantine/core';
import { createPolymorphicComponent, Text } from '@mantine/core';
import clsx from 'clsx';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useCheckProfanity } from '~/hooks/useCheckProfanity';
import { publicBrowsingLevelsFlag } from '~/shared/constants/browsingLevel.constants';

interface BlurTextProps extends TextProps {
  children: React.ReactNode;
  blur?: boolean;
}

const _BlurText = forwardRef<HTMLParagraphElement, BlurTextProps>(
  ({ children, blur, ...props }, ref) => {
    const [blurNsfw, browsingLevel] = useBrowsingSettings((state) => [
      state.blurNsfw,
      state.browsingLevel,
    ]);
    const shouldBlur =
      blur !== undefined ? blur : blurNsfw || browsingLevel <= publicBrowsingLevelsFlag;

    // Extract all text content to clean with the hook
    const extractTextContent = (content: React.ReactNode): string => {
      if (typeof content === 'string') {
        return content;
      }
      if (React.isValidElement(content)) {
        return extractTextContent(content.props.children);
      }
      if (Array.isArray(content)) {
        return content.map(extractTextContent).join('');
      }
      return '';
    };

    // Get the full text content
    const fullText = extractTextContent(children);

    const { cleanedText, isLoading } = useCheckProfanity(fullText, {
      enabled: shouldBlur,
      replacementStyle: 'asterisk',
    });

    // Blur the original text until the dynamic list resolves, so we don't
    // flash uncensored content.
    if (shouldBlur && isLoading) {
      return (
        <Text
          component="span"
          ref={ref}
          {...props}
          className={clsx(props.className, 'select-none blur-sm')}
        >
          {children}
        </Text>
      );
    }

    if (!shouldBlur || cleanedText === fullText) {
      return (
        <Text component="span" ref={ref} {...props}>
          {children}
        </Text>
      );
    }

    return (
      <Text component="span" ref={ref} {...props}>
        {cleanedText}
      </Text>
    );
  }
);
_BlurText.displayName = 'BlurText';

export const BlurText = createPolymorphicComponent<'span', BlurTextProps>(_BlurText);
