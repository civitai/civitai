import { Button, ButtonProps } from '@mantine/core';
import React, { MouseEventHandler, useRef, useState } from 'react';

export const ConfirmButton = ({
  children,
  onConfirmed: onClick,
  confirmLabel = 'Are you sure?',
  confirmTimeout = 3000,
  ...props
}: ButtonProps & {
  onConfirmed: MouseEventHandler<HTMLButtonElement>;
  confirmLabel?: React.ReactNode;
  confirmTimeout?: number;
}) => {
  const [confirming, setConfirming] = useState(false);
  const timeoutRef = useRef<NodeJS.Timeout>();

  return (
    <Button
      {...props}
      onClick={(e: React.MouseEvent) => {
        if (confirming) {
          clearTimeout(timeoutRef.current);
          // @ts-ignore
          onClick(e);
        } else {
          timeoutRef.current = setTimeout(() => {
            setConfirming(false);
          }, confirmTimeout);
        }
        setConfirming((c) => !c);
      }}
    >
      {confirming ? confirmLabel : children}
    </Button>
  );
};
