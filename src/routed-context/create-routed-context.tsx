import { useRouter } from 'next/router';
import { useEffect, useState } from 'react';
import { z } from 'zod';
import { QS } from '~/utils/qs';

export type RoutedContext = {
  opened: boolean;
  close: () => void;
};

type RoutedContextProps<TSchema extends z.AnyZodObject> = {
  context: RoutedContext;
  props: z.infer<TSchema>;
};

export function createRoutedContext<TSchema extends z.AnyZodObject>({
  schema,
  element: BaseComponent,
}: {
  schema: TSchema;
  element:
    | React.ForwardRefExoticComponent<RoutedContextProps<TSchema>>
    | ((props: RoutedContextProps<TSchema>) => JSX.Element);
}) {
  function RoutedContext(props: z.infer<TSchema>) {
    const router = useRouter();
    const [opened, setOpened] = useState(false);
    const result = schema.safeParse(props);

    useEffect(() => {
      setOpened(true);
    }, [router]);

    useEffect(() => {
      router.beforePopState(({ as }) => {
        if (as !== router.asPath) {
          const [pathname, query] = as.split('?');
          // spread out props I don't want to pass to my router replace
          const { modal, hasHistory, ...rest } = router.query;
          router.replace({ pathname, query: { ...rest, ...(QS.parse(query) as any) } }, as, {
            shallow: true,
          });
          return false;
        }
        return true;
      });

      return () => router.beforePopState(() => true);
    }, [router, router.query]);

    const handleClose = () => {
      const { hostname: HOSTNAME } = new URL(location.origin);
      const REFERRER =
        document.referrer.length > 0 ? new URL(document.referrer).hostname : undefined;

      // TODO - extra check to compare rererrer domain to our domain
      // const { hostname } = new URL(document.referrer);

      HOSTNAME !== REFERRER
        ? router.replace(
            { pathname: router.asPath.split('?')[0], query: router.query },
            { pathname: router.asPath.split('?')[0] },
            { shallow: true }
          )
        : router.back();
    };

    if (!result.success) return null;

    return <BaseComponent context={{ opened, close: handleClose }} props={result.data} />;
  }

  return RoutedContext;
}

// const { hostname: HOSTNAME } = new URL(process.env.NEXTAUTH_URL ?? 'www.civitai.com');
// console.log({ HOSTNAME });
