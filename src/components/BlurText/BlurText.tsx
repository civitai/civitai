import React, { forwardRef } from 'react';
import type { TextProps } from '@mantine/core';
import { createPolymorphicComponent, Text } from '@mantine/core';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useCleanText } from '~/hooks/useCheckProfanity';

interface BlurTextProps extends TextProps {
  children: React.ReactNode;
  blur?: boolean;
}

const _BlurText = forwardRef<HTMLParagraphElement, BlurTextProps>(
  ({ children, blur, ...props }, ref) => {
    const blurNsfw = useBrowsingSettings((state) => state.blurNsfw);
    const shouldBlur = blur !== undefined ? blur : blurNsfw;

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

    // Use the hook to clean the text
    const cleanedText = useCleanText(fullText, {
      enabled: shouldBlur,
      replacementStyle: 'asterisk',
    });

    // If no profanity filtering needed, return original children
    if (!shouldBlur || cleanedText === fullText) {
      return (
        <Text component="span" ref={ref} {...props}>
          {children}
        </Text>
      );
    }

    // Return cleaned text for simple cases
    return (
      <Text component="span" ref={ref} {...props}>
        {cleanedText}
      </Text>
    );
  }
);
_BlurText.displayName = 'BlurText';

export const BlurText = createPolymorphicComponent<'span', BlurTextProps>(_BlurText);
