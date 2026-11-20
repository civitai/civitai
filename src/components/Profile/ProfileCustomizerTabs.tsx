import { Select, Stack, Tabs } from '@mantine/core';
import React from 'react';

export type ProfileCustomizerPanel = {
  value: string;
  label: string;
  /** The form fields on this tab, so a failed save can show the tab holding the error. */
  fields: string[];
  content: React.ReactNode;
};

export function ProfileCustomizerTabs({
  panels,
  value,
  onChange,
}: {
  panels: ProfileCustomizerPanel[];
  value: string;
  onChange: (value: string) => void;
}) {
  const active = panels.some((p) => p.value === value) ? value : panels[0]?.value;

  return (
    // Every panel stays mounted: the form registers its fields as they render.
    <Tabs value={active} onChange={(next) => next && onChange(next)} keepMounted>
      <Select
        className="sm:hidden"
        aria-label="Customize section"
        data={panels.map(({ value, label }) => ({ value, label }))}
        value={active}
        onChange={(next) => next && onChange(next)}
        allowDeselect={false}
        comboboxProps={{ withinPortal: true }}
      />
      <Tabs.List className="max-sm:hidden">
        {panels.map((panel) => (
          <Tabs.Tab key={panel.value} value={panel.value}>
            {panel.label}
          </Tabs.Tab>
        ))}
      </Tabs.List>
      {panels.map((panel) => (
        <Tabs.Panel key={panel.value} value={panel.value} pt="md">
          <Stack>{panel.content}</Stack>
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
