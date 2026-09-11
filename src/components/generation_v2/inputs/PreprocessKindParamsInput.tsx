/**
 * PreprocessKindParamsInput
 *
 * Renders the active preprocessor kind's parameters from the spec list the
 * graph node publishes in `meta.specs`, writing them into the free-form
 * `kindParams` record. Shared by the image and video control-preprocessor
 * workflows, whose params are described by the same `ParamSpec` shape.
 */

import { Select, Switch } from '@mantine/core';
import type { ParamSpec } from '~/shared/data-graph/generation/image-preprocess-graph';
import { SliderInput } from './SliderInput';

export interface PreprocessKindParamsInputProps {
  value?: Record<string, unknown> | null;
  onChange?: (value: Record<string, unknown>) => void;
  specs?: readonly ParamSpec[];
}

export function PreprocessKindParamsInput({
  value,
  onChange,
  specs,
}: PreprocessKindParamsInputProps) {
  if (!specs?.length) return null;
  const params = value ?? {};
  const setParam = (key: string, v: unknown) => onChange?.({ ...params, [key]: v });

  return (
    <div className="flex flex-col gap-2">
      {specs.map((spec) => {
        if (spec.type === 'slider') {
          return (
            <SliderInput
              key={spec.key}
              label={spec.label}
              value={(params[spec.key] as number | undefined) ?? spec.defaultValue}
              onChange={(v) => setParam(spec.key, v)}
              min={spec.min}
              max={spec.max}
              step={spec.step ?? 1}
            />
          );
        }
        if (spec.type === 'boolean') {
          return (
            <Switch
              key={spec.key}
              label={spec.label}
              checked={(params[spec.key] as boolean | undefined) ?? spec.defaultValue}
              onChange={(e) => setParam(spec.key, e.currentTarget.checked)}
            />
          );
        }
        return (
          <Select
            key={spec.key}
            label={spec.label}
            data={spec.options.map((o) => ({ label: o, value: o }))}
            value={(params[spec.key] as string | undefined) ?? spec.defaultValue}
            onChange={(v) => v && setParam(spec.key, v)}
            allowDeselect={false}
            comboboxProps={{ withinPortal: true }}
          />
        );
      })}
    </div>
  );
}
