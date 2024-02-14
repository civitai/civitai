import { forwardRef } from 'react';
import { SubNav } from '~/components/AppLayout/SubNav';
import { ScrollArea, ScrollAreaProps } from '~/components/ScrollArea/ScrollArea';

export const ScrollAreaMain = forwardRef<HTMLElement, ScrollAreaProps>(
  ({ children, ...props }, ref) => {
    return (
      <ScrollArea ref={ref} pt={0} {...props}>
        <SubNav />
        {children}
      </ScrollArea>
    );
  }
);

ScrollAreaMain.displayName = 'ScrollAreaMain';
