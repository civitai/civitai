import type { ComponentProps, ComponentType } from 'react';
import type { UrlObject } from 'url';

type Url = UrlObject | string;

/**
 * A routed dialog's URL rule. It names its modal only through `import type`, so importing it never
 * loads the modal; `RoutedDialogProvider` alone maps names to components.
 */
export type RoutedDialog<TProps> = {
  requireAuth?: boolean;
  target?: string;
  resolve: (
    query: Record<string, unknown>,
    args: TProps
  ) => { query: Record<string, unknown>; asPath?: Url; state?: Record<string, unknown> | any };
};

export const routedDialog = <TComponent extends ComponentType<any>>(
  dialog: RoutedDialog<ComponentProps<TComponent>>
) => dialog;
