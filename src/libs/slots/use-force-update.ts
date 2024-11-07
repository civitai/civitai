import React from 'react';

export const useForceUpdate = () => {
  const [, rerender] = React.useState({});
  return React.useCallback(() => rerender({}), []);
};
