import { useWindowEvent } from '@mantine/hooks';
import { NextRouter, useRouter } from 'next/router';
import { createContext, useEffect } from 'react';

type ScopedRouterState = NextRouter;
const ScopedRouterCtx = createContext<ScopedRouterState>({} as ScopedRouterState);

export const ScopedRouterProvider = ({ children }: { children: React.ReactElement }) => {
  const router = useRouter();

  // const handleNavigate = (id: number) => {
  //   const { galleryImageId, ...query } = router.query;
  //   const [, queryString] = router.asPath.split('?');

  //   let as = `/gallery/${id}`;
  //   if (!!queryString?.length) as += `?${queryString}`;

  //   const nextState = {
  //     ...history.state,
  //     as,
  //     url: `${router.pathname}?${QS.stringify(router.query)}`,
  //   };
  //   history.replaceState(nextState, '', as);
  //   setIndex(images.findIndex((x) => x.id === id));
  //   // router.replace(
  //   //   { query: { ...query, galleryImageId: id } },
  //   //   { pathname: `/gallery/${id}`, query: { ...QS.parse(queryString) } as any },
  //   //   { shallow: true }
  //   // );
  // };

  return <ScopedRouterCtx.Provider value={{ ...router }}>{children}</ScopedRouterCtx.Provider>;
};
