import React, { forwardRef } from 'react';
import { createPolymorphicComponent, Box } from '@mantine/core';
import { useBrowsingSettings } from '~/providers/BrowserSettingsProvider';
import profanityFilter from '~/libs/profanity';

interface BlurTextProps {
  children: React.ReactNode;
  blur?: boolean;
}

const _BlurText = forwardRef<HTMLElement, BlurTextProps>(({ children, blur, ...props }, ref) => {
  const blurNsfw = useBrowsingSettings((state) => state.blurNsfw);
  const shouldBlur = blur !== undefined ? blur : blurNsfw;

  // If shouldBlur is false, return children as-is
  if (!shouldBlur) {
    return (
      <Box component="span" ref={ref} {...props}>
        {children}
      </Box>
    );
  }

  const processTextContent = (content: React.ReactNode): React.ReactNode => {
    if (typeof content === 'string') {
      return profanityFilter.censor(content);
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

export const BlurText = createPolymorphicComponent<'span', BlurTextProps>(_BlurText);
