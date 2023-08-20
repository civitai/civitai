import Router from 'next/router';

export const basePath = '/models/train';
export const maxSteps = 3;

// these could use the current route to determine?
export const goNext = (modelId: number | undefined, step: number) => {
  console.log('got to go next');
  if (modelId && step < maxSteps)
    Router.replace(`${basePath}?modelId=${modelId}&step=${step + 1}`, undefined, {
      shallow: true,
    });
};
export const goBack = (modelId: number | undefined, step: number) => {
  if (modelId && step > 1)
    Router.replace(`${basePath}?modelId=${modelId}&step=${step - 1}`, undefined, {
      shallow: true,
    });
};
