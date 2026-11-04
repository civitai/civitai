import type { MantineTheme } from '@mantine/core';
import { useMantineTheme } from '@mantine/core';
import { useIsomorphicEffect } from '@mantine/hooks';
import type { ReactElement, Ref } from 'react';
import React, {
  createContext,
  forwardRef,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from 'react';
import { flushSync } from 'react-dom';

/**
 * Shared machinery for the closed-overlay fast path; the contract is in `./index.ts`. Two
 * invariants are not obvious from the code:
 *  - The trigger never remounts when Mantine mounts (that would drop its focus, state and DOM node
 *    mid-interaction). Mantine mounts BESIDE it and clones an `OverlaySlot` instead; the trigger
 *    applies what the slot reports.
 *  - The arming listener is a capturing listener on the trigger node, so it runs before React's
 *    bubble-phase dispatch at the root: arming there (with `flushSync`) lets that same first event
 *    reach Mantine's handlers.
 */

export type AnyProps = Record<string, unknown>;
type AnyRef = Ref<unknown> | undefined;

export type TargetInput = { props: AnyProps; ref: AnyRef; child: ReactElement };
export type DropdownInput = { props: AnyProps; ref: AnyRef };
export type SlotOutput = { props: AnyProps; ref: AnyRef };

export type BridgeStore = {
  getTarget: () => TargetInput | null;
  getDropdown: () => DropdownInput | null;
  getOut: () => SlotOutput | null;
  setTarget: (value: TargetInput | null) => void;
  setDropdown: (value: DropdownInput | null) => void;
  /** Called by the slot with the props and ref Mantine cloned it with. */
  setOut: (props: AnyProps, ref: AnyRef) => void;
  subscribe: (listener: () => void) => () => void;
};

export function createBridgeStore(): BridgeStore {
  let target: TargetInput | null = null;
  let dropdown: DropdownInput | null = null;
  let out: SlotOutput | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((listener) => listener());
  return {
    getTarget: () => target,
    getDropdown: () => dropdown,
    getOut: () => out,
    setTarget(value) {
      if (value === target) return;
      target = value;
      emit();
    },
    setDropdown(value) {
      if (value === dropdown) return;
      dropdown = value;
      emit();
    },
    setOut(props, ref) {
      // Only what Mantine ADDED or CHANGED relative to the child's own props, so the trigger
      // always renders the child's current props and Mantine's additions on top — the same object
      // Mantine's own `cloneElement(child, {...})` builds.
      const given = (target?.child.props ?? {}) as AnyProps;
      const diff: AnyProps = {};
      for (const key of Object.keys(props)) if (props[key] !== given[key]) diff[key] = props[key];
      if (out && out.ref === ref && shallowEqual(out.props, diff)) return;
      out = { props: diff, ref };
      emit();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function shallowEqual(a: AnyProps, b: AnyProps) {
  const ak = Object.keys(a);
  if (ak.length !== Object.keys(b).length) return false;
  return ak.every((k) => Object.is(a[k], b[k]));
}

export const getNull = () => null;

/** The store of the overlay whose real Mantine component is rendering this slot. */
export const SlotStoreContext = createContext<BridgeStore | null>(null);

/**
 * Stands in for the trigger inside the real Mantine component and renders nothing. It receives the
 * trigger's own props (so Mantine composes the trigger's handlers and classes exactly as usual) and
 * reports what Mantine cloned it with after every render.
 */
export const OverlaySlot = forwardRef<unknown, AnyProps>(function OverlaySlot(props, ref) {
  const store = useContext(SlotStoreContext);
  useIsomorphicEffect(() => {
    store?.setOut(props, (ref ?? undefined) as AnyRef);
  });
  return null;
});

/** Events that arm an overlay. Each one precedes every event Mantine opens an overlay on. */
export const ARM_EVENTS = [
  'pointerover',
  'pointermove',
  'pointerdown',
  'mouseover',
  'mousedown',
  'touchstart',
  'focus',
  'click',
  'keydown',
] as const;

export type Arm = (sync: boolean) => void;

/** Armed state for one overlay: once armed it stays armed for the overlay's lifetime. */
export function useArmState() {
  const [armed, setArmed] = useState(false);
  const armedRef = useRef(false);
  const arm = useCallback<Arm>((sync) => {
    if (armedRef.current) return;
    armedRef.current = true;
    // `sync` comes from a native listener on the trigger, which runs between React's capture and
    // bubble dispatch of the same event: flushing here is what lets that event reach Mantine.
    if (sync) flushSync(() => setArmed(true));
    else setArmed(true);
  }, []);
  /** For a render-phase arm (a controlled `opened` that turned true). */
  const armDuringRender = () => {
    armedRef.current = true;
    setArmed(true);
  };
  return { armed, arm, armedRef, armDuringRender };
}

/**
 * A callback ref that attaches the arming listeners to the trigger's DOM node, and records whether
 * the child ever handed a node over at all (`seen`): a child that does not forward its ref cannot
 * be armed by its events, so the caller arms it after mount instead (Mantine's own behaviour).
 */
export function useArmRef(arm: Arm, armedRef: { current: boolean }) {
  // Listeners are keyed by NODE, not by ref identity. A parent overlay arming in the same event
  // (`Tooltip > Menu.Target > button`) re-renders this trigger with a new merged ref, so React calls
  // this ref with null and then with the same node mid-dispatch; a listener removed and re-added
  // there would not run for that event (DOM dispatch skips listeners added after it started), and
  // this overlay would miss its first click. So a null only schedules the detach, and the same
  // node coming back cancels it.
  const attached = useRef<{ node: EventTarget | null; off: (() => void) | null; pending: boolean }>(
    { node: null, off: null, pending: false }
  );
  const seen = useRef(false);
  const ref = useCallback(
    (node: unknown) => {
      const state = attached.current;
      if (!node || typeof (node as EventTarget).addEventListener !== 'function') {
        if (state.off && !state.pending) {
          state.pending = true;
          queueMicrotask(() => {
            if (!state.pending) return;
            state.off?.();
            state.off = null;
            state.node = null;
            state.pending = false;
          });
        }
        return;
      }
      seen.current = true;
      if (state.node === node && state.off) {
        state.pending = false;
        return;
      }
      state.off?.();
      state.off = null;
      state.node = null;
      state.pending = false;
      if (armedRef.current) return;
      const el = node as EventTarget;
      const off = () => {
        for (const type of ARM_EVENTS) el.removeEventListener(type, onEvent, { capture: true });
        if (state.off === off) {
          state.off = null;
          state.node = null;
          state.pending = false;
        }
      };
      // Arming is one-way, so the first event detaches all nine listeners before it arms: an armed
      // trigger keeps none of them (pointermove/pointerover would otherwise fire on every move).
      const onEvent = () => {
        off();
        arm(true);
      };
      for (const type of ARM_EVENTS)
        el.addEventListener(type, onEvent, { capture: true, passive: true });
      state.node = el;
      state.off = off;
    },
    [arm, armedRef]
  );
  return { ref, seen };
}

/** Mantine's `isElement` (core/utils/is-element): what its targets accept as a child. */
export function isElement(value: unknown): value is ReactElement {
  if (Array.isArray(value) || value === null) return false;
  if (typeof value === 'object') return (value as ReactElement).type !== Fragment;
  return false;
}

/** Throws Mantine's error for a target child its `isElement` rejects. */
export function assertElement(value: unknown, message: string): asserts value is ReactElement {
  if (!isElement(value)) throw new Error(message);
}

/** Mantine's `getRefProp` (core/utils/get-ref-prop): an element's ref, per React major. */
export function getRefProp(element: ReactElement): AnyRef {
  const version = React.version;
  if (typeof version !== 'string' || version.startsWith('18.'))
    return (element as unknown as { ref?: AnyRef })?.ref ?? undefined;
  return (element?.props as { ref?: AnyRef })?.ref;
}

/** `useMantineTheme`, or `null` outside a MantineProvider (where every overlay stays on Mantine). */
export function useOptionalMantineTheme(): MantineTheme | null {
  try {
    return useMantineTheme();
  } catch {
    return null;
  }
}

/** A component's theme `defaultProps`, resolved like Mantine's `useProps`. */
export function themeDefaults(theme: MantineTheme, name: string): AnyProps {
  const payload = (theme.components as Record<string, { defaultProps?: unknown }> | undefined)?.[
    name
  ]?.defaultProps;
  const resolved = typeof payload === 'function' ? payload(theme) : payload;
  return (resolved ?? {}) as AnyProps;
}

/** The first defined value of `key`: explicit prop, then each theme layer in order. */
export function pick(key: string, props: AnyProps, ...layers: AnyProps[]): unknown {
  if (props[key] !== undefined) return props[key];
  for (const layer of layers) if (layer[key] !== undefined) return layer[key];
  return undefined;
}

export function omit(source: AnyProps, keys: ReadonlySet<string>): AnyProps {
  const result: AnyProps = {};
  for (const key of Object.keys(source)) if (!keys.has(key)) result[key] = source[key];
  return result;
}

/**
 * Called by the real Mantine component's wrapper once it has mounted and the browser has had a
 * frame. Until then a controlled `opened` is held at `false`, so an overlay armed by `opened`
 * turning true still mounts closed and then opens — with Mantine's enter transition, as it would
 * have from an already-mounted overlay. Mantine's transition only animates a CHANGE of `mounted`
 * seen after its own mount effects, hence the frame rather than a layout effect.
 */
export const OnMounted = memo(function OnMounted({ onMounted }: { onMounted: () => void }) {
  useEffect(() => {
    const frame = requestAnimationFrame(() => onMounted());
    return () => cancelAnimationFrame(frame);
  }, [onMounted]);
  return null;
});

/** Mirrors each static of a Mantine component lazily, so importing this module never reads one. */
export function defineLazyStatics(
  target: object,
  getSource: () => unknown,
  keys: readonly string[]
): void {
  for (const key of keys) {
    Object.defineProperty(target, key, {
      configurable: true,
      enumerable: true,
      get: () => (getSource() as Record<string, unknown>)[key],
    });
  }
}
