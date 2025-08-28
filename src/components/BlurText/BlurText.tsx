import React, { forwardRef } from 'react';
import { createPolymorphicComponent, Box } from '@mantine/core';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import { useModerationBlocklists } from '~/hooks/useModerationBlocklists';

interface BlurTextProps {
  children: React.ReactNode;
  blur?: boolean;
}

const _BlurText = forwardRef<HTMLElement, BlurTextProps>(({ children, blur, ...props }, ref) => {
  const blurNsfw = useBrowsingSettings((state) => state.blurNsfw);
  const shouldBlur = blur !== undefined ? blur : blurNsfw;

  const { data: blocklists, isLoading } = useModerationBlocklists({ enabled: shouldBlur });

  // If shouldBlur is false, return children as-is
  if (!shouldBlur) {
    return (
      <Box component="span" ref={ref} {...props}>
        {children}
      </Box>
    );
  }

  // If still loading blocklists, return children as-is
  if (isLoading || !blocklists) {
    return (
      <Box component="span" ref={ref} {...props}>
        {children}
      </Box>
    );
  }

  const processTextContent = (content: React.ReactNode): React.ReactNode => {
    if (typeof content === 'string') {
      return blurTextContent(content, blocklists.words);
    }

    if (React.isValidElement(content)) {
      return React.cloneElement(content, {
        ...content.props,
        children: React.Children.map(content.props.children, processTextContent),
      });
    }

    if (Array.isArray(content)) {
      return content.map(processTextContent);
    }

    return content;
  };

  const processedChildren = processTextContent(children);

  return (
    <Box component="span" ref={ref} {...props}>
      {processedChildren}
    </Box>
  );
});
_BlurText.displayName = 'BlurText';

function blurTextContent(text: string, wordBlocklist: Array<{ re: RegExp; word: string }>): string {
  let processedText = text;

  // Check against word blocklist only
  for (const { re } of wordBlocklist) {
    processedText = processedText.replace(re, (match) => '*'.repeat(match.length));
  }

  return processedText;
}

export const BlurText = createPolymorphicComponent<'span', BlurTextProps>(_BlurText);
