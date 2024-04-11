import { stringify } from 'query-string';
import { env } from '~/env/server.mjs';

type OrchestratorFetchProps = {
  method?: string;
  params?: object;
  body?: any;
};

export async function orchestratorFetch(
  url: string,
  { method, params, body }: OrchestratorFetchProps
) {
  if (params)
    url += stringify(params, {
      skipEmptyString: true,
      skipNull: true,
      sort: false,
    });

  const response = await fetch(url, {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.ORCHESTRATOR_ACCESS_TOKEN}`,
    },
  });

  if (!response.ok)
    await response
      .json()
      .then((json) => {
        throw new Error(json);
      })
      .catch((reason) => {
        throw new Error(reason);
      });

  return response;
}
