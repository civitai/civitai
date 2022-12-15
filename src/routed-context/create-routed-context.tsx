import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { useRoutedContext } from '~/routed-context/routed-context.provider';
import { QS } from '~/utils/qs';

export type RoutedContext = {
  opened: boolean;
  close: () => void;
};

export type RoutedContextProps<TSchema extends z.AnyZodObject> = {
  context: RoutedContext;
  props: z.infer<TSchema>;
};

export function createRoutedContext<TSchema extends z.AnyZodObject>({
  schema,
  Element: BaseComponent,
}: {
  schema: TSchema;
  Element:
    | React.ForwardRefExoticComponent<RoutedContextProps<TSchema>>
    | ((props: RoutedContextProps<TSchema>) => JSX.Element);
}) {
  function RoutedContext(props: z.infer<TSchema>) {
    const router = useRouter();
    // const [opened, setOpened] = useState(false);
    const result = schema.safeParse(props);
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
          router.replace({ pathname, query: { ...rest, ...(QS.parse(query) as any) } }, as, {
            shallow: true,
          });
          return false;
        }
        return true;
      });

      return () => router.beforePopState(() => true);
    }, [router, router.query]);

    if (!result.success) return null;

    return <BaseComponent context={{ opened: true, close: closeContext }} props={result.data} />;
  }

  return RoutedContext;
}
