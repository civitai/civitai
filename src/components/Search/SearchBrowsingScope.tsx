import type { ComponentType, ReactNode, RefAttributes } from 'react';
import { forwardRef } from 'react';
import { ViewerBrowsingLevelScope } from '~/components/BrowsingLevel/BrowsingLevelProvider';
import { BrowsingSettingsAddonsProvider } from '~/providers/BrowsingSettingsAddonsProvider';

/**
 * Search lists other people's content, so it follows the viewer, not the page (the homepage's PG
 * override wraps the header search too).
 *
 * 🔴 The nested addons provider is required: addons resolve from the browsing level, and the outer
 * one resolved them at the page level. Without it the level filter widens to NSFW while the PG-level
 * addons leave the minor exclusion off.
 */
export function SearchBrowsingScope({ children }: { children: ReactNode }) {
  return (
    <ViewerBrowsingLevelScope>
      <BrowsingSettingsAddonsProvider>{children}</BrowsingSettingsAddonsProvider>
    </ViewerBrowsingLevelScope>
  );
}

/**
 * A HOC rather than a hand-written wrapper so nothing can read the level or the addons ABOVE the
 * scope and pass them in.
 */
export function withSearchBrowsingScope<TRef, TProps extends object>(
  Component: ComponentType<TProps & RefAttributes<TRef>>
) {
  const Scoped = forwardRef<TRef, TProps>((props, ref) => (
    <SearchBrowsingScope>
      <Component {...(props as TProps)} ref={ref} />
    </SearchBrowsingScope>
  ));
  Scoped.displayName = `withSearchBrowsingScope(${Component.displayName ?? Component.name})`;
  return Scoped;
}
