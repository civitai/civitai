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
