import { SubNav } from '~/components/AppLayout/SubNav';
import { ScrollArea, ScrollAreaProps } from '~/components/ScrollArea/ScrollArea';

export function ScrollAreaMain({ children, ...props }: ScrollAreaProps) {
  return (
    <ScrollArea {...props}>
      <SubNav />
      {children}
    </ScrollArea>
  );
}
