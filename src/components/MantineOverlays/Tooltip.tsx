import type { MantineTheme } from '@mantine/core';
import { Tooltip as MantineTooltip, useProps } from '@mantine/core';
import { useIsomorphicEffect, useMergedRef } from '@mantine/hooks';
import cx from 'clsx';
import type { ComponentType, ReactElement, Ref } from 'react';
import {
  cloneElement,
  createElement,
  forwardRef,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId as useReactId,
  useState,
  useSyncExternalStore,
} from 'react';
import type { AnyProps, BridgeStore } from './bridge';
import {
  createBridgeStore,
  defineLazyStatics,
  getNull,
  getRefProp,
  assertElement,
  OnMounted,
  OverlaySlot,
  pick,
  SlotStoreContext,
  themeDefaults,
  useArmRef,
  useArmState,
  useOptionalMantineTheme,
} from './bridge';
import { OverlayFastPathContext } from './overlayFastPathContext';

const TOOLTIP_CHILD_ERROR =
  '[@mantine/core] Tooltip component children should be an element or a component that accepts ref, fragments, strings, numbers and other primitive values are not supported';
const TOOLTIP_DEFAULTS = { refProp: 'ref' };

function tooltipEligible(props: AnyProps, theme: MantineTheme) {
  const td = themeDefaults(theme, 'Tooltip');
  if (props.opened === true) return false;
  if (pick('defaultOpened', props, td)) return false;
  if (pick('keepMounted', props, td)) return false;
  return true;
}

const TooltipFull = memo(function TooltipFull({
  tooltipProps,
  forwardedRef,
  store,
  holdClosed,
  onMounted,
}: {
  tooltipProps: AnyProps;
  forwardedRef: Ref<unknown>;
  store: BridgeStore;
  holdClosed: boolean;
  onMounted: () => void;
}) {
  const target = useSyncExternalStore(store.subscribe, store.getTarget, store.getTarget);
  const { children: _children, ...props } = tooltipProps;
  if (holdClosed && props.opened !== undefined) props.opened = false;
  return (
    <SlotStoreContext.Provider value={store}>
      {target
        ? createElement(
            MantineTooltip as unknown as ComponentType<AnyProps>,
            { ...props, ref: forwardedRef },
            <OverlaySlot {...(target.child.props as AnyProps)} ref={getRefProp(target.child)} />
          )
        : null}
      <OnMounted onMounted={onMounted} />
    </SlotStoreContext.Provider>
  );
});

function TooltipLite({
  tooltipProps,
  forwardedRef,
}: {
  tooltipProps: AnyProps;
  forwardedRef: Ref<unknown>;
}) {
  const p = useProps('Tooltip', TOOLTIP_DEFAULTS, tooltipProps) as AnyProps;
  // Mantine's Tooltip calls `useId` (in `useTooltip`), which gives everything under the trigger a
  // deeper tree id; this call does the same, so the ids under the trigger are Mantine's.
  useReactId();
  const [store] = useState(createBridgeStore);
  const { armed, arm, armedRef, armDuringRender } = useArmState();
  const [mounted, setMounted] = useState(false);
  const onMounted = useCallback(() => setMounted(true), []);
  if (!armed && tooltipProps.opened === true) armDuringRender();
  const child = p.children;
  assertElement(child, TOOLTIP_CHILD_ERROR);
  const out = useSyncExternalStore(store.subscribe, store.getOut, getNull);
  const childRef = getRefProp(child);
  const armRef = useArmRef(arm, armedRef);
  const liteRef = useMergedRef(childRef, forwardedRef, armRef.ref);
  useIsomorphicEffect(() => {
    store.setTarget({ props: {}, ref: forwardedRef ?? undefined, child });
  }, [store, child, forwardedRef]);
  useEffect(() => {
    // The child never handed over a DOM node, so its events cannot arm it: arm now.
    if (!armRef.seen.current) arm(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const childProps = (child as ReactElement<AnyProps>).props;
  // Mantine's own object for the trigger (`getReferenceProps({...})` in Tooltip.mjs), without the
  // floating-ui handlers a closed, unarmed tooltip has no use for.
  const trigger = out
    ? cloneElement(child, { ...out.props, ref: out.ref ?? childRef })
    : cloneElement(child, {
        onClick: p.onClick,
        onMouseEnter: p.onMouseEnter,
        onMouseLeave: p.onMouseLeave,
        onMouseMove: p.onMouseMove,
        onPointerDown: p.onPointerDown,
        onPointerEnter: p.onPointerEnter,
        className: cx(p.className as string, childProps.className as string),
        ...childProps,
        [p.refProp as string]: liteRef,
      });
  // Mantine renders [portal, trigger]: the same two-child shape, trigger second.
  return (
    <>
      {armed ? (
        <TooltipFull
          tooltipProps={tooltipProps}
          forwardedRef={forwardedRef}
          store={store}
          holdClosed={!mounted}
          onMounted={onMounted}
        />
      ) : null}
      {trigger}
    </>
  );
}

const TooltipImpl = forwardRef<unknown, AnyProps>(function OverlayTooltip(props, ref) {
  const enabled = useContext(OverlayFastPathContext);
  const theme = useOptionalMantineTheme();
  // Read once, at mount: swapping trees later would remount the trigger, losing its focus and state.
  const [lite] = useState(() => enabled && theme !== null && tooltipEligible(props, theme));
  if (lite) return <TooltipLite tooltipProps={props} forwardedRef={ref} />;
  return createElement(MantineTooltip as unknown as ComponentType<AnyProps>, {
    ...props,
    ref,
  });
});
TooltipImpl.displayName = 'MantineOverlays/Tooltip';
defineLazyStatics(TooltipImpl, () => MantineTooltip, [
  'Group',
  'Floating',
  'classes',
  'extend',
  'withProps',
]);

export const Tooltip = TooltipImpl as unknown as typeof MantineTooltip;
