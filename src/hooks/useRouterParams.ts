import { useRouter } from 'next/router';

/* TODO
  When we access route params, automatically parse numbers. Optionally use zod validation to ensure that the params return expected values
*/
export const useRouterParams = () => {
  const router = useRouter();

  return router.query;
};
