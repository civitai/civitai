import { Request } from 'playwright';

export const apiResp = (d: any, meta?: any) => {
  return {
    result: {
      data: {
        json: d,
        meta: meta ?? {},
      },
    },
  };
};

export const parseRequestParams = (request: Request) => {
  return JSON.parse(request.postData() ?? '{}').json?.params ?? {};
};
