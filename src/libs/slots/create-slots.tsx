import React, { createContext, useCallback, useContext, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useIsomorphicLayoutEffect from './useIsomorphicLayoutEffect';

/**
 * createSlots — Portal-based slots that work from anywhere in the tree.
 *
 * Inspired by .NET MVC @section / @RenderSection:
 * - `Slot` declares content from anywhere (like @section)
 * - `RenderSlot` places it in the layout (like @RenderSection)
 * - Content is portaled into the target DOM node via useLayoutEffect (no flash)
 *
 * Usage:
 *   const { SlotProvider, Slot, RenderSlot } = createSlots(['header', 'footer']);
 */

type RenderSlotProps<T extends string> = React.HTMLAttributes<HTMLDivElement> & {
  name: T;
  fallback?: React.ReactNode;
};

type ConvenienceRenderProps = React.HTMLAttributes<HTMLDivElement> & {
  fallback?: React.ReactNode;
};

function createSlots<T extends string>(slotNames: T[]) {
  type SlotTargets = { [K in T]?: HTMLElement | null };

  const TargetContext = createContext<React.MutableRefObject<SlotTargets> | null>(null);

  /** Wrap your layout + content tree in this provider */
  function SlotProvider({ children }: { children: React.ReactNode }) {
    const targetsRef = useRef<SlotTargets>({} as SlotTargets);
    return <TargetContext.Provider value={targetsRef}>{children}</TargetContext.Provider>;
  }

  /** Returns true when rendered inside a SlotProvider */
  function useHasSlots() {
    return useContext(TargetContext) !== null;
  }

  /** Place this in your layout where the slot content should appear.
   *  Analogous to @RenderSection("name") in .NET MVC.
   *  `fallback` renders when no Slot has claimed this name (SSR + initial render).
   *  All extra props (className, style, etc.) are forwarded to the wrapper div.
   */
  function RenderSlot({ name, fallback, ...divProps }: RenderSlotProps<T>) {
    const targetsRef = useContext(TargetContext);
    const ref = useCallback(
      (node: HTMLDivElement | null) => {
        if (targetsRef) targetsRef.current[name] = node;
      },
      [targetsRef, name]
    );

    return (
      <div ref={ref} data-slot={name} {...divProps}>
        {fallback}
      </div>
    );
  }

  /** Declare slot content from anywhere in the tree.
   *  Analogous to @section Name { ... } in .NET MVC.
   *  The children get portaled into the matching RenderSlot target.
   */
  function Slot({ name, children }: { name: T; children: React.ReactNode }) {
    const targetsRef = useContext(TargetContext);
    const [target, setTarget] = useState<HTMLElement | null>(null);

    useIsomorphicLayoutEffect(() => {
      const el = targetsRef?.current[name];
      if (el) {
        // Clear fallback content once portal takes over
        el.textContent = '';
        setTarget(el);
      }
      return () => {
        setTarget(null);
      };
    }, [targetsRef, name]);

    if (!target) return null;
    return createPortal(children, target);
  }

  // Create convenience sub-components keyed by slot name
  // e.g. slots.Header = (props) => <Slot name="header" {...props} />
  const slotComponents = {} as {
    [K in T as Capitalize<K>]: React.FC<{ children: React.ReactNode }>;
  };
  const renderComponents = {} as {
    [K in T as `Render${Capitalize<K>}`]: React.FC<ConvenienceRenderProps>;
  };

  for (const name of slotNames) {
    const capitalized = (name.charAt(0).toUpperCase() + name.slice(1)) as Capitalize<T>;

    const SlotComponent: React.FC<{ children: React.ReactNode }> = ({ children }) => (
      <Slot name={name}>{children}</Slot>
    );
    SlotComponent.displayName = `Slot(${name})`;
    (slotComponents as any)[capitalized] = SlotComponent;

    const RenderComponent: React.FC<ConvenienceRenderProps> = ({ fallback, ...divProps }) => (
      <RenderSlot name={name} fallback={fallback} {...divProps} />
    );
    RenderComponent.displayName = `RenderSlot(${name})`;
    (renderComponents as any)[`Render${capitalized}`] = RenderComponent;
  }

  return {
    SlotProvider,
    Slot,
    RenderSlot,
    useHasSlots,
    ...slotComponents,
    ...renderComponents,
  };
}

export default createSlots;
