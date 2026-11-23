import type { ComponentProps, ComponentType } from 'react';
import { createElement, lazy } from 'react';
import type { Dialog } from '~/components/Dialog/dialogStore';
import { dialogStore } from '~/components/Dialog/dialogStore';

export type OpenDialogOptions = {
  /** Dedupes: opening an id that is already open does nothing. Also what `dialogStore.closeById` takes. */
  id?: Dialog['id'];
  target?: string | HTMLElement;
  onClose?: () => void;
};

type PropsArgs<P> = object extends P
  ? [props?: P, options?: OpenDialogOptions]
  : [props: P, options?: OpenDialogOptions];

type ComponentKeys<M> = {
  [K in keyof M]: M[K] extends ComponentType<any> ? K : never;
}[keyof M] &
  string;

/** Ids for dialogs opened without one, so a failed load can close its own entry. */
let opened = 0;

/**
 * Opens a dialog whose module loads on first open: pass the import, not the component, so the
 * modal loads when opened, not with the opener. Props are checked against the loaded component.
 *
 *   openDialog(() => import('~/components/Report/ReportModal'), { entityType, entityId });
 *   openDialog(() => import('./AddToCollectionModal'), 'AddToCollectionModal', props, { id });
 */
export function openDialog<P>(
  load: () => Promise<{ default: ComponentType<P> }>,
  ...args: PropsArgs<P>
): void;
export function openDialog<M, K extends ComponentKeys<M>>(
  load: () => Promise<M>,
  exportName: K,
  ...args: PropsArgs<ComponentProps<Extract<M[K], ComponentType<any>>>>
): void;
export function openDialog(
  load: () => Promise<Record<string, ComponentType<any>>>,
  ...rest: unknown[]
) {
  const named = typeof rest[0] === 'string';
  const exportName = named ? (rest[0] as string) : 'default';
  const [props, options] = (named ? rest.slice(1) : rest) as [
    object | undefined,
    OpenDialogOptions?
  ];
  const id = options?.id ?? `open-dialog-${++opened}`;
  // Set when the provider closes this dialog (Back, Escape, a close button), so a load that fails
  // afterwards leaves the closed dialog, or a newer one with the same id, alone.
  let closed = false;
  const onClose = () => {
    closed = true;
    options?.onClose?.();
  };
  // React.lazy throws a failed import to the nearest error boundary, which wraps the whole page.
  // A chunk that won't load (a tab left open across a deploy) closes the dialog instead.
  const Lazy = lazy(() =>
    load()
      .then((module) => ({ default: module[exportName] }))
      .catch((error) => {
        console.error('openDialog: the dialog module failed to load', error);
        if (!closed) {
          onClose(); // callers that answer from onClose (App Blocks replies) still answer
          dialogStore.closeById(id);
        }
        return { default: () => null };
      })
  );
  // The store is immer, which freezes what it holds; React writes to a lazy object as it loads, so
  // the store holds this function instead.
  const component = (componentProps: object) => createElement(Lazy, componentProps);
  dialogStore.trigger({
    component,
    props,
    id,
    target: options?.target,
    options: { onClose },
  });
}
