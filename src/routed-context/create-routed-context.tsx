import { useRouter } from 'next/router';
import { useEffect } from 'react';
import { z } from 'zod';
import { useCurrentUser } from '~/hooks/useCurrentUser';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { QS } from '~/utils/qs';
import useIsClient from '~/hooks/useIsClient';

export type RoutedContext = {
  opened: boolean;
  close: () => void;
};

export type RoutedContextProps<TSchema extends z.AnyZodObject> = {
  context: RoutedContext;
  props: z.infer<TSchema>;
};

// TODO - handle optional schema/schema props that would make the Element props optional
export function createRoutedContext<TSchema extends z.AnyZodObject>({
  authGuard,
  schema,
  Element: BaseComponent,
}: {
  authGuard?: boolean;
  schema?: TSchema;
  Element:
    | React.ForwardRefExoticComponent<RoutedContextProps<TSchema>>
    | ((props: RoutedContextProps<TSchema>) => JSX.Element);
}) {
  function RoutedContext(props: z.infer<TSchema>) {
    const isClient = useIsClient();
    const router = useRouter();
    const user = useCurrentUser();
    // const [opened, setOpened] = useState(false);
    const result = schema?.safeParse(props) ?? { success: true, data: {} };
    const { closeContext } = useRoutedContext();

    // useEffect(() => {
    //   setOpened(true);
    // }, [router]);

    // console.log('fire');

    // this effect is necessary for catching browser back button actions outside of our control
    // for some reason this effect won't work in routed-context.provider.tsx
    useEffect(() => {
      router.beforePopState(({ as }) => {
        if (as !== router.asPath) {
          const [pathname, query] = as.split('?');
          // spread out props I don't want to pass to my router replace
          const { modal, ...rest } = router.query;
          router.replace({ pathname, query: { ...rest, ...(QS.parse(query) as any) } }, as, { //eslint-disable-line
            shallow: true,
          });
          return false;
        }
        return true;
      });

      return () => router.beforePopState(() => true);
    }, [router, router.query]);

    if (!result.success) return null;
    if (!user && authGuard) {
      if (isClient) closeContext();
      return null;
    }

    return <BaseComponent context={{ opened: true, close: closeContext }} props={result?.data} />;
  }

  return RoutedContext;
}

/*
  - consider keeping track of state outside of the context of `useRouter`
  - clicking to open a modal could set some global state var and then use window.history to push a new url like this
  ```
  history.pushState({
    ...history.state,
    as: "/models/2220/babes?modal=reviewThread&reviewId=5513",
    key: 'frupy',
    url: "/models/[id]/[[...slug]]?id=2220&slug=babes&reviewId=5513&modal=reviewThread"
  })
  ```
*/
