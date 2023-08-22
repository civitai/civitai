import { LoaderProps, Loader } from '@mantine/core';
import { useTimeout } from '@mantine/hooks';
import { useState } from 'react';

export const TimeoutLoader = ({
  renderTimeout,
  delay = 5000,
  ...props
}: LoaderProps & { renderTimeout: () => React.ReactElement; delay?: number }) => {
  const [showTimeOut, setShowTimeOut] = useState(false);
  useTimeout(() => setShowTimeOut(true), delay, { autoInvoke: true });

  if (showTimeOut) {
    return renderTimeout();
  }

  return <Loader {...props} />;
};
