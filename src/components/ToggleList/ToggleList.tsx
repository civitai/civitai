import React from 'react';
import styles from './ToggleList.module.scss';
import clsx from 'clsx';
import { Paper, Switch } from '@mantine/core';

export function ToggleList({ children }: { children: React.ReactNode }) {
  return (
    <Paper withBorder p={0}>
      {children}
    </Paper>
  );
}

ToggleList.Item = function ToggleListItem({
  checked,
  onChange,
  children,
  disabled,
}: {
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  children: React.ReactNode;
  disabled?: boolean;
}) {
  function handleClick() {
    onChange?.(!checked);
  }

  return (
    <div
      className={clsx('flex items-center justify-between px-4 py-3', styles.item, {
        [styles.active]: checked,
      })}
      onClick={handleClick}
    >
      {children}
      <Switch checked={checked} onClick={handleClick} disabled={disabled} />
    </div>
  );
};
