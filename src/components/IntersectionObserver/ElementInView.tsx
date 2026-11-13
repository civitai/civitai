import { useMergedRef } from '@mantine/hooks';
import type {
  ComponentPropsWithRef,
  ComponentPropsWithoutRef,
  ElementType,
  ForwardedRef,
  ReactElement,
  ReactNode,
  Ref,
} from 'react';
import { createContext, forwardRef, useContext, useEffect } from 'react';
import { useInView } from '~/hooks/useInView';
import { useTrackImpression } from '~/components/TrackView/useTrackImpression';
import type { ImpressionTarget } from '~/components/TrackView/useTrackImpression';

const ElementInViewContext = createContext<boolean | null>(null);

/**
 * Reads the visibility boolean published by the nearest `ElementInView` (or
 * `ElementInView.Provider`). Returns `null` when no boundary is in scope —
 * consumers typically treat that as "not gated".
 */
export function useElementInView() {
  return useContext(ElementInViewContext);
}

type OwnProps = {
  children?: ReactNode;
  /** Initial value returned before the observer has reported. */
  initialInView?: boolean;
  /**
   * Entities this element presents, reported as feed impressions once it has been
   * half visible for a second. A card that already renders through this component
   * tracks with this prop; one that does not calls `useTrackImpression` on its own
   * root rather than gaining a second `useInView` observer by wrapping in this.
   */
  impressions?: ImpressionTarget[];
};

type ElementInViewProps<C extends ElementType> = OwnProps & {
  /** The element or component used to render the root. Defaults to `div`. */
  component?: C;
} & Omit<ComponentPropsWithoutRef<C>, keyof OwnProps | 'component'>;

type PolymorphicRef<C extends ElementType> = ComponentPropsWithRef<C>['ref'];

type ElementInViewPropsWithRef<C extends ElementType> = ElementInViewProps<C> & {
  ref?: PolymorphicRef<C>;
};

type ElementInViewComponent = {
  <C extends ElementType = 'div'>(props: ElementInViewPropsWithRef<C>): ReactElement | null;
  Provider: typeof ElementInViewContext.Provider;
  displayName?: string;
};

function ElementInViewImpl<C extends ElementType = 'div'>(
  { component, children, initialInView, impressions, ...rest }: ElementInViewProps<C>,
  forwardedRef: ForwardedRef<unknown>
) {
  const Component = (component ?? 'div') as ElementType;
  const { ref: internalRef, inView } = useInView({ initialInView });
  const impressionRef = useTrackImpression<HTMLElement>(impressions);
  const mergedRef = useMergedRef(
    internalRef as Ref<HTMLElement>,
    impressionRef,
    forwardedRef as Ref<HTMLElement>
  );

  return (
    <Component ref={mergedRef} {...rest}>
      <ElementInViewContext.Provider value={inView}>{children}</ElementInViewContext.Provider>
    </Component>
  );
}

// `forwardRef` is not generic-preserving, so we recast the wrapped result to
// the polymorphic signature. This is the standard pattern for polymorphic
// forwardRef components in TS.
export const ElementInView = forwardRef(ElementInViewImpl) as unknown as ElementInViewComponent;
ElementInView.displayName = 'ElementInView';
ElementInView.Provider = ElementInViewContext.Provider;
