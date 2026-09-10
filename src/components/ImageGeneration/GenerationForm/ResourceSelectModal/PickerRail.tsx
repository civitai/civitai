import { createContext, useContext } from 'react';

/**
 * Below `md` the rail is disclosed as a step inside the pane rather than as a
 * column beside it, and the two want different chrome. The rail component is
 * opaque to whoever renders it, so the presentation is passed down instead of
 * through props.
 */
const InlineRailContext = createContext(false);

export function InlineRail({ children }: { children: React.ReactNode }) {
  return <InlineRailContext.Provider value={true}>{children}</InlineRailContext.Provider>;
}

/**
 * The picker's left column.
 *
 * A rail is present when the catalog's SCOPE is selectable — the checkpoint
 * picker's ecosystem — and absent when the catalog is already scoped and the
 * toolbar is what narrows it. The rail owns this chrome rather than the parent
 * so that a rail rendering null takes no width, instead of leaving an empty
 * 224px box the parent had no way to know about.
 *
 * Viewport breakpoint, not `@md`: Mantine's Modal sets no containerType (only
 * Drawer does), so container-query variants never resolve in here.
 */
export function PickerRail({ children }: { children: React.ReactNode }) {
  const inline = useContext(InlineRailContext);

  if (inline)
    return <div className="flex max-h-80 flex-col gap-1 overflow-y-auto p-2">{children}</div>;

  return (
    <div className="hidden w-56 shrink-0 border-r border-gray-3 md:flex dark:border-dark-4">
      <div className="flex min-h-0 w-full flex-col gap-1 overflow-y-auto p-2">{children}</div>
    </div>
  );
}
