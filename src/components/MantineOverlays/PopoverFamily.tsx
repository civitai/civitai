import type { MantineTheme } from '@mantine/core';
import {
  HoverCard as MantineHoverCard,
  Menu as MantineMenu,
  Popover as MantinePopover,
  useProps,
} from '@mantine/core';
import { useId, useIsomorphicEffect, useMergedRef } from '@mantine/hooks';
import cx from 'clsx';
import type { ComponentType, Context, ReactElement, ReactNode, Ref } from 'react';
import {
  Children,
  cloneElement,
  createContext,
  createElement,
  forwardRef,
  isValidElement,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { AnyProps, Arm, BridgeStore } from './bridge';
import {
  createBridgeStore,
  defineLazyStatics,
  getNull,
  getRefProp,
  assertElement,
  OnMounted,
  omit,
  OverlaySlot,
  pick,
  SlotStoreContext,
  themeDefaults,
  useArmRef,
  useArmState,
  useOptionalMantineTheme,
} from './bridge';
import { OverlayFastPathContext } from './overlayFastPathContext';

/**
 * Popover, Menu and HoverCard: one Mantine `Popover` underneath, so one implementation, with a
 * `kind` for what differs (the Mantine components, which props count as "opened", and the extra
 * attributes each target adds). The trigger markup each kind emits while closed copies what Mantine
 * emits; `__tests__/overlay-fast-path.ssr.test.ts` pins it byte for byte, so re-run it on a Mantine
 * upgrade.
 */

type AnyComponent = ComponentType<AnyProps>;

type LiteCtxValue = {
  store: BridgeStore;
  arm: Arm;
  armedRef: { current: boolean };
  /** `useId(id)` called where Mantine's `Popover` calls it, so the ids are the same. */
  uid: string;
  withRoles: boolean;
  /** The root's unknown props, which Mantine's Popover hands to its target (`ctx.targetProps`). */
  targetProps: AnyProps;
};

type FamilyKind = {
  name: string;
  Ctx: Context<LiteCtxValue | null>;
  Root: () => AnyComponent;
  Target: () => AnyComponent;
  Dropdown: () => AnyComponent;
  /** Our Dropdown component, to find it among the root's children. Set after creation. */
  OwnDropdown?: unknown;
  targetChildError: string;
  /** The root may take the fast path (flag aside): it is closed and nothing renders while closed. */
  eligible: (props: AnyProps, theme: MantineTheme) => boolean;
  /** The root is (now) open through a prop. */
  isOpenProp: (props: AnyProps) => boolean;
  useResolve: (props: AnyProps) => { id: unknown; withRoles: boolean; targetProps: AnyProps };
  /** The closed trigger, as Mantine's target components would clone it. */
  useLiteTarget: (ctx: LiteCtxValue, targetProps: AnyProps, ref: Ref<unknown>) => ReactElement;
};

// The props Mantine's `Popover` destructures; the rest is `others`, handed to the target. This list
// and the Menu and HoverCard lists below mirror Mantine: re-check all three on a Mantine upgrade.
const POPOVER_KNOWN = new Set([
  'children',
  'position',
  'offset',
  'onPositionChange',
  'positionDependencies',
  'opened',
  'transitionProps',
  'onExitTransitionEnd',
  'onEnterTransitionEnd',
  'width',
  'middlewares',
  'withArrow',
  'arrowSize',
  'arrowOffset',
  'arrowRadius',
  'arrowPosition',
  'unstyled',
  'classNames',
  'styles',
  'closeOnClickOutside',
  'withinPortal',
  'portalProps',
  'closeOnEscape',
  'clickOutsideEvents',
  'trapFocus',
  'onClose',
  'onDismiss',
  'onOpen',
  'onChange',
  'zIndex',
  'radius',
  'shadow',
  'id',
  'defaultOpened',
  '__staticSelector',
  'withRoles',
  'disabled',
  'returnFocus',
  'variant',
  'keepMounted',
  'vars',
  'floatingStrategy',
  'withOverlay',
  'overlayProps',
]);
// The props Mantine's `Menu` destructures; the rest goes to its Popover.
const MENU_KNOWN = new Set([
  'children',
  'onOpen',
  'onClose',
  'opened',
  'defaultOpened',
  'trapFocus',
  'onChange',
  'closeOnItemClick',
  'loop',
  'closeOnEscape',
  'trigger',
  'openDelay',
  'closeDelay',
  'classNames',
  'styles',
  'unstyled',
  'variant',
  'vars',
  'menuItemTabIndex',
  'keepMounted',
  'withInitialFocusPlaceholder',
]);
// The props Mantine's `HoverCard` destructures; the rest goes to its Popover.
const HOVERCARD_KNOWN = new Set([
  'children',
  'onOpen',
  'onClose',
  'openDelay',
  'closeDelay',
  'initiallyOpened',
]);

const POPOVER_RESOLVE_DEFAULTS = { withRoles: true };
const POPOVER_TARGET_DEFAULTS = { refProp: 'ref', popupType: 'dialog' };
const REF_PROP_DEFAULTS = { refProp: 'ref' };

/** Mantine's `Popover` resolution of `id`, `withRoles` and the target's share of the props. */
function usePopoverResolve(props: AnyProps) {
  const p = useProps('Popover', POPOVER_RESOLVE_DEFAULTS, props) as AnyProps;
  return { id: p.id, withRoles: p.withRoles === true, targetProps: omit(p, POPOVER_KNOWN) };
}

/** Mantine's `Popover.Target` clone of a closed trigger, minus its event handlers. */
function usePopoverTargetLite(
  ctx: LiteCtxValue,
  targetProps: AnyProps,
  ref: Ref<unknown>
): ReactElement {
  const t = useProps('PopoverTarget', POPOVER_TARGET_DEFAULTS, targetProps) as AnyProps;
  const { children, refProp, popupType, ...forwarded } = t;
  const child = children as ReactElement<AnyProps>;
  const accessible = ctx.withRoles
    ? {
        'aria-haspopup': popupType,
        'aria-expanded': false,
        'aria-controls': `${ctx.uid}-dropdown`,
        id: `${ctx.uid}-target`,
      }
    : {};
  return cloneElement(child, {
    ...forwarded,
    ...accessible,
    ...ctx.targetProps,
    className: cx(
      ctx.targetProps.className as string,
      forwarded.className as string,
      child.props.className as string
    ),
    [refProp as string]: ref,
  });
}

function dropdownIsLastChild(children: unknown, Dropdown: unknown) {
  const all = Children.toArray(children as ReactNode);
  const count = all.filter((c) => isValidElement(c) && c.type === Dropdown).length;
  const last = all[all.length - 1];
  return count === 1 && isValidElement(last) && last.type === Dropdown;
}

/**
 * Closed, and nothing would render while closed. With `withinPortal` off the real dropdown mounts
 * after the root's children (beside the trigger), which is where Mantine puts it only when it is
 * the root's last child — anything else stays on Mantine.
 */
function eligibleWith(
  kind: FamilyKind,
  props: AnyProps,
  layers: AnyProps[],
  startsOpen: boolean
): boolean {
  if (startsOpen) return false;
  if (pick('keepMounted', props, ...layers)) return false;
  const withinPortal = pick('withinPortal', props, ...layers) ?? true;
  if (!withinPortal && !dropdownIsLastChild(props.children, kind.OwnDropdown)) return false;
  return true;
}

const PopoverCtx = createContext<LiteCtxValue | null>(null);
const MenuCtx = createContext<LiteCtxValue | null>(null);
const HoverCardCtx = createContext<LiteCtxValue | null>(null);

const popoverKind: FamilyKind = {
  name: 'Popover',
  Ctx: PopoverCtx,
  Root: () => MantinePopover as unknown as AnyComponent,
  Target: () => MantinePopover.Target as unknown as AnyComponent,
  Dropdown: () => MantinePopover.Dropdown as unknown as AnyComponent,
  targetChildError:
    'Popover.Target component children should be an element or a component that accepts ref. Fragments, strings, numbers and other primitive values are not supported',
  eligible(props, theme) {
    const pd = themeDefaults(theme, 'Popover');
    const startsOpen = props.opened === true || !!pick('defaultOpened', props, pd);
    return eligibleWith(this, props, [pd], startsOpen);
  },
  isOpenProp: (props) => props.opened === true,
  useResolve: usePopoverResolve,
  useLiteTarget: (ctx, targetProps, ref) => usePopoverTargetLite(ctx, targetProps, ref),
};

const menuKind: FamilyKind = {
  name: 'Menu',
  Ctx: MenuCtx,
  Root: () => MantineMenu as unknown as AnyComponent,
  Target: () => MantineMenu.Target as unknown as AnyComponent,
  Dropdown: () => MantineMenu.Dropdown as unknown as AnyComponent,
  targetChildError:
    'Menu.Target component children should be an element or a component that accepts ref. Fragments, strings, numbers and other primitive values are not supported',
  eligible(props, theme) {
    const md = themeDefaults(theme, 'Menu');
    const pd = themeDefaults(theme, 'Popover');
    const startsOpen = props.opened === true || !!pick('defaultOpened', props, md);
    return eligibleWith(this, props, [md, pd], startsOpen);
  },
  isOpenProp: (props) => props.opened === true,
  useResolve(props) {
    const m = useProps('Menu', {}, props) as AnyProps;
    return usePopoverResolve(omit(m, MENU_KNOWN));
  },
  useLiteTarget(ctx, targetProps, ref) {
    const m = useProps('MenuTarget', REF_PROP_DEFAULTS, targetProps) as AnyProps;
    const { children, refProp, ...others } = m;
    // MenuTarget's own clone (its handlers aside), then Popover.Target with popupType "menu".
    const inner = cloneElement(children as ReactElement, { 'data-expanded': undefined });
    return usePopoverTargetLite(
      ctx,
      { refProp, popupType: 'menu', ...others, children: inner },
      ref
    );
  },
};

const hoverCardKind: FamilyKind = {
  name: 'HoverCard',
  Ctx: HoverCardCtx,
  Root: () => MantineHoverCard as unknown as AnyComponent,
  Target: () => MantineHoverCard.Target as unknown as AnyComponent,
  Dropdown: () => MantineHoverCard.Dropdown as unknown as AnyComponent,
  targetChildError:
    'HoverCard.Target component children should be an element or a component that accepts ref. Fragments, strings, numbers and other primitive values are not supported',
  eligible(props, theme) {
    const hd = themeDefaults(theme, 'HoverCard');
    const pd = themeDefaults(theme, 'Popover');
    return eligibleWith(this, props, [hd, pd], !!pick('initiallyOpened', props, hd));
  },
  isOpenProp: () => false,
  useResolve(props) {
    const h = useProps('HoverCard', {}, props) as AnyProps;
    return usePopoverResolve(omit(h, HOVERCARD_KNOWN));
  },
  useLiteTarget(ctx, targetProps, ref) {
    const h = useProps('HoverCardTarget', REF_PROP_DEFAULTS, targetProps) as AnyProps;
    const { children, refProp, eventPropsWrapperName, ...others } = h;
    const child = children as ReactElement<AnyProps>;
    const listeners = {
      onMouseEnter: child.props.onMouseEnter,
      onMouseLeave: child.props.onMouseLeave,
    };
    const inner = cloneElement(
      child,
      eventPropsWrapperName ? { [eventPropsWrapperName as string]: listeners } : listeners
    );
    return usePopoverTargetLite(ctx, { refProp, ...others, children: inner }, ref);
  },
};

/** The real Mantine component, beside the trigger, fed by what the target and dropdown publish. */
const FamilyFull = memo(function FamilyFull({
  kind,
  rootProps,
  store,
  holdClosed,
  onMounted,
}: {
  kind: FamilyKind;
  rootProps: AnyProps;
  store: BridgeStore;
  holdClosed: boolean;
  onMounted: () => void;
}) {
  const target = useSyncExternalStore(store.subscribe, store.getTarget, store.getTarget);
  const dropdown = useSyncExternalStore(store.subscribe, store.getDropdown, store.getDropdown);
  const { children: _children, ...props } = rootProps;
  if (holdClosed && props.opened !== undefined) props.opened = false;
  const Root = kind.Root();
  const Target = kind.Target();
  const Dropdown = kind.Dropdown();
  return (
    <SlotStoreContext.Provider value={store}>
      <kind.Ctx.Provider value={null}>
        {createElement(
          Root,
          props,
          target
            ? createElement(
                Target,
                { ...target.props, ref: target.ref },
                <OverlaySlot {...(target.child.props as AnyProps)} ref={getRefProp(target.child)} />
              )
            : null,
          dropdown ? createElement(Dropdown, { ...dropdown.props, ref: dropdown.ref }) : null
        )}
      </kind.Ctx.Provider>
      <OnMounted onMounted={onMounted} />
    </SlotStoreContext.Provider>
  );
});

function FamilyLite({ kind, rootProps }: { kind: FamilyKind; rootProps: AnyProps }) {
  const resolved = kind.useResolve(rootProps);
  // The same `useId(id)` Mantine's Popover makes, at the same place in the tree: the same ids.
  const uid = useId(resolved.id as string | undefined);
  const [store] = useState(createBridgeStore);
  const { armed, arm, armedRef, armDuringRender } = useArmState();
  const [mounted, setMounted] = useState(false);
  const onMounted = useCallback(() => setMounted(true), []);
  if (!armed && kind.isOpenProp(rootProps)) armDuringRender();
  const ctx = useMemo<LiteCtxValue>(
    () => ({
      store,
      arm,
      armedRef,
      uid,
      withRoles: resolved.withRoles,
      targetProps: resolved.targetProps,
    }),
    [store, arm, armedRef, uid, resolved.withRoles, resolved.targetProps]
  );
  // `{children}{…}`: the same two-child array Mantine's Popover renders ([children, overlay]), so
  // every id under the trigger is the one Mantine would have produced.
  return (
    <kind.Ctx.Provider value={ctx}>
      {rootProps.children as ReactNode}
      {armed ? (
        <FamilyFull
          kind={kind}
          rootProps={rootProps}
          store={store}
          holdClosed={!mounted}
          onMounted={onMounted}
        />
      ) : null}
    </kind.Ctx.Provider>
  );
}

function FamilyLiteTarget({
  kind,
  ctx,
  targetProps,
  forwardedRef,
}: {
  kind: FamilyKind;
  ctx: LiteCtxValue;
  targetProps: AnyProps;
  forwardedRef: Ref<unknown>;
}) {
  const child = targetProps.children;
  assertElement(child, kind.targetChildError);
  const out = useSyncExternalStore(ctx.store.subscribe, ctx.store.getOut, getNull);
  const childRef = getRefProp(child);
  const armRef = useArmRef(ctx.arm, ctx.armedRef);
  const liteRef = useMergedRef(childRef, forwardedRef, armRef.ref);
  useIsomorphicEffect(() => {
    const { children: _children, ...props } = targetProps;
    ctx.store.setTarget({ props, ref: forwardedRef ?? undefined, child });
  }, [ctx.store, targetProps, forwardedRef]);
  useIsomorphicEffect(() => () => ctx.store.setTarget(null), [ctx.store]);
  useEffect(() => {
    // The child never handed over a DOM node, so its events cannot arm it: arm now.
    if (!armRef.seen.current) ctx.arm(false);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const lite = kind.useLiteTarget(ctx, targetProps, liteRef);
  if (out) return cloneElement(child, { ...out.props, ref: out.ref ?? childRef });
  return lite;
}

function FamilyLiteDropdown({
  store,
  dropdownProps,
  forwardedRef,
}: {
  store: BridgeStore;
  dropdownProps: AnyProps;
  forwardedRef: Ref<unknown>;
}) {
  useIsomorphicEffect(() => {
    store.setDropdown({ props: dropdownProps, ref: forwardedRef ?? undefined });
  }, [store, dropdownProps, forwardedRef]);
  useIsomorphicEffect(() => () => store.setDropdown(null), [store]);
  return null;
}

function createFamily(kind: FamilyKind, staticKeys: readonly string[]) {
  function OverlayRoot(props: AnyProps) {
    const enabled = useContext(OverlayFastPathContext);
    const theme = useOptionalMantineTheme();
    // Read once, at mount: swapping trees later would remount the trigger, losing its focus and state.
    const [lite] = useState(() => enabled && theme !== null && kind.eligible(props, theme));
    if (lite) return <FamilyLite kind={kind} rootProps={props} />;
    return <kind.Ctx.Provider value={null}>{createElement(kind.Root(), props)}</kind.Ctx.Provider>;
  }
  OverlayRoot.displayName = `MantineOverlays/${kind.name}`;

  const Target = forwardRef<unknown, AnyProps>(function OverlayTarget(props, ref) {
    const ctx = useContext(kind.Ctx);
    if (ctx)
      return <FamilyLiteTarget kind={kind} ctx={ctx} targetProps={props} forwardedRef={ref} />;
    return createElement(kind.Target(), { ...props, ref });
  });
  Target.displayName = `MantineOverlays/${kind.name}.Target`;

  const Dropdown = forwardRef<unknown, AnyProps>(function OverlayDropdown(props, ref) {
    const ctx = useContext(kind.Ctx);
    if (ctx)
      return <FamilyLiteDropdown store={ctx.store} dropdownProps={props} forwardedRef={ref} />;
    return createElement(kind.Dropdown(), { ...props, ref });
  });
  Dropdown.displayName = `MantineOverlays/${kind.name}.Dropdown`;
  kind.OwnDropdown = Dropdown;

  Object.assign(OverlayRoot, { Target, Dropdown });
  defineLazyStatics(OverlayRoot, kind.Root, staticKeys);
  return OverlayRoot;
}

export const Popover = createFamily(popoverKind, ['extend']) as unknown as typeof MantinePopover;
export const Menu = createFamily(menuKind, [
  'extend',
  'withProps',
  'classes',
  'Item',
  'Label',
  'Divider',
]) as unknown as typeof MantineMenu;
export const HoverCard = createFamily(hoverCardKind, [
  'extend',
]) as unknown as typeof MantineHoverCard;
