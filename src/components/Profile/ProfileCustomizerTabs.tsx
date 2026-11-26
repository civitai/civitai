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
  header,
}: {
  panels: ProfileCustomizerPanel[];
  value: string;
  onChange: (value: string) => void;
  /** Shown above the tabs, and pinned with them while the dialog scrolls. */
  header?: React.ReactNode;
}) {
  const active = panels.some((p) => p.value === value) ? value : panels[0]?.value;

  return (
    // Every panel stays mounted: the form registers its fields as they render.
    <Tabs value={active} onChange={(next) => next && onChange(next)} keepMounted>
      <div className="sticky -top-4 z-20 -mx-4 -mt-4 flex flex-col gap-3 bg-[var(--mantine-color-body)] px-4 pt-4">
        {header}
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
      </div>
      {panels.map((panel) => (
        <Tabs.Panel key={panel.value} value={panel.value} pt="md">
          <Stack>{panel.content}</Stack>
        </Tabs.Panel>
      ))}
    </Tabs>
  );
}
