import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import useIsomorphicLayoutEffect from './useIsomorphicLayoutEffect';

/**
 * createSlots — Portal-based slots that work from anywhere in the tree.
 *
 * Inspired by .NET MVC @section / @RenderSection:
 * - `Slot` declares content from anywhere (like @section)
 * - `RenderSlot` places it in the layout (like @RenderSection)
 * - Content is portaled into the target DOM node
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

type SlotRegistry<T extends string> = {
  targets: { [K in T]?: HTMLElement | null };
  listeners: Set<() => void>;
};

function createSlots<T extends string>(slotNames: T[]) {
  const RegistryContext = createContext<SlotRegistry<T> | null>(null);

  /** Wrap your layout + content tree in this provider */
  function SlotProvider({ children }: { children: React.ReactNode }) {
    // Stable ref — never causes re-renders
    const registryRef = useRef<SlotRegistry<T> | null>(null);
    if (!registryRef.current) {
      registryRef.current = { targets: {} as SlotRegistry<T>['targets'], listeners: new Set() };
    }
    return (
      <RegistryContext.Provider value={registryRef.current}>{children}</RegistryContext.Provider>
    );
  }

  /** Returns true when rendered inside a SlotProvider */
  function useHasSlots() {
    return useContext(RegistryContext) !== null;
  }

  /** Place this in your layout where the slot content should appear. */
  function RenderSlot({ name, fallback, ...divProps }: RenderSlotProps<T>) {
    const registry = useContext(RegistryContext);
    const ref = useCallback(
      (node: HTMLDivElement | null) => {
        if (!registry) return;
        registry.targets[name] = node;
        // Notify on both mount and unmount so Slots can track target replacement
        registry.listeners.forEach((cb) => cb());
      },
      [registry, name]
    );

    return (
      <div ref={ref} data-slot={name} {...divProps}>
        {fallback}
      </div>
    );
  }

  /** Declare slot content from anywhere in the tree. */
  function Slot({ name, children }: { name: T; children: React.ReactNode }) {
    const registry = useContext(RegistryContext);
    const [target, setTarget] = useState<HTMLElement | null>(null);

    // Try to resolve immediately on mount
    useIsomorphicLayoutEffect(() => {
      const el = registry?.targets[name];
      if (el) {
        el.textContent = '';
        setTarget(el);
      }
    }, [registry, name]);

    // Subscribe for target changes (late registration, replacement, or removal)
    useEffect(() => {
      if (!registry) return;
      const cb = () => {
        const el = registry.targets[name] ?? null;
        setTarget((prev) => {
          if (el === prev) return prev;
          if (el) el.textContent = '';
          return el;
        });
      };
      registry.listeners.add(cb);
      return () => {
        registry.listeners.delete(cb);
      };
    }, [registry, name]);

    // Clear on unmount
    useIsomorphicLayoutEffect(() => {
      return () => setTarget(null);
    }, []);

    if (!target) return null;
    return createPortal(children, target);
  }

  // Create convenience sub-components keyed by slot name
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
