import { Input, Alert } from '@mantine/core';
import { useMemo } from 'react';
import { maxUpscaleSize } from '~/server/common/constants';
import { withController } from '~/libs/form/hoc/withController';
import type { SourceImageProps } from '~/server/orchestrator/infrastructure/base.schema';
import { Radio, RadioGroup } from '@headlessui/react';
import clsx from 'clsx';
import type { SourceImageUploadProps } from '~/components/Generation/Input/SourceImageUpload';
import { SourceImageUpload } from '~/components/Generation/Input/SourceImageUpload';

function SourceImageUpscale({
  value,
  onChange,
  upscaleMultiplier,
  upscaleResolution,
  ...rest
}: SourceImageUploadProps & {
  upscaleMultiplier?: boolean;
  upscaleResolution?: boolean;
}) {
  const upscale = upscaleMultiplier || upscaleResolution;

  function handleResolutionChange(upscaleValues: { upscaleWidth: number; upscaleHeight: number }) {
    if (value) {
      onChange?.({ ...value, ...upscaleValues });
    }
  }

  return (
    <>
      <SourceImageUpload value={value} onChange={onChange} {...rest} />
      {/* {value && upscale && <ResolutionSlider value={value} onChange={handleResolutionChange} />} */}
      {value && upscale && (
        <UpscalePicker
          value={value}
          onChange={handleResolutionChange}
          upscaleMultiplier={upscaleMultiplier}
          upscaleResolution={upscaleResolution}
        />
      )}
    </>
  );
}

export const InputSourceImageUpscale = withController(SourceImageUpscale, ({ field }) => ({
  value: field.value,
}));

const upscaleMultipliers = [1.5, 2, 2.5, 3];
const upscaleResolutions = [
  { label: '2K', value: 2048 },
  { label: '4K', value: 3840 },
  // { label: '8K', value: 7680 },
];

function UpscalePicker({
  value,
  onChange,
  upscaleMultiplier,
  upscaleResolution,
}: {
  value: SourceImageProps;
  onChange: (args: { upscaleWidth: number; upscaleHeight: number }) => void;
  upscaleMultiplier?: boolean;
  upscaleResolution?: boolean;
}) {
  const min = Math.max(value.width, value.height);
  const _value = Math.max(value.upscaleHeight ?? 0, value.upscaleWidth ?? 0);
  function handleChange(target: number) {
    const upscaleValues = getUpscaleSizes({ ...value, target });
    onChange({ ...value, ...upscaleValues });
  }

  const multiplierOptions = useMemo(
    () =>
      upscaleMultipliers.map((multiplier) => {
        const value = Math.ceil((min * multiplier) / 64) * 64;
        return {
          value,
          label: multiplier,
          disabled: maxUpscaleSize < value,
        };
      }),
    [min]
  );

  const resolutionOptions = useMemo(
    () =>
      upscaleResolutions.map(({ label, value }) => {
        return { label, value, disabled: value <= min };
      }),
    [min]
  );

  return (
    <div className="flex flex-col gap-3">
      {(value.width === value.upscaleWidth || value.height === value.upscaleHeight) && (
        <Alert color="yellow">This image cannot be upscaled any further.</Alert>
      )}
      {upscaleMultiplier && (
        <Input.Wrapper label="Upscale Multiplier">
          <RadioGroup value={_value} onChange={handleChange} className="flex gap-2">
            {multiplierOptions.map(({ label, value, disabled }) => (
              <RadioInput key={value} value={value} label={label} disabled={disabled} />
            ))}
          </RadioGroup>
        </Input.Wrapper>
      )}

      {upscaleResolution && (
        <Input.Wrapper label="Upscale Resolution">
          <RadioGroup value={_value} onChange={handleChange} className="flex gap-2">
            {resolutionOptions.map(({ label, value, disabled }) => (
              <RadioInput key={value} value={value} label={label} disabled={disabled} />
            ))}
          </RadioGroup>
        </Input.Wrapper>
      )}

      <div className="rounded-md bg-gray-2 px-6 py-4 dark:bg-dark-6">
        <span className="font-bold">Upscale Dimensions:</span> {value.upscaleWidth} x{' '}
        {value.upscaleHeight}
      </div>
    </div>
  );
}

function RadioInput({
  value,
  label,
  disabled,
}: {
  value: any;
  label: React.ReactNode;
  disabled?: boolean;
}) {
  return (
    <Radio
      value={value}
      disabled={disabled}
      className={clsx(
        !disabled ? 'cursor-pointer focus:outline-none' : 'cursor-not-allowed opacity-25',
        'flex flex-1 items-center justify-center rounded-md  p-3 text-sm font-semibold uppercase ring-1  data-[checked]:text-white   data-[checked]:ring-0 data-[focus]:data-[checked]:ring-2 data-[focus]:ring-2 data-[focus]:ring-offset-2  sm:flex-1  [&:not([data-focus])]:[&:not([data-checked])]:ring-inset  ',
        'bg-white text-dark-9 ring-gray-4 hover:bg-gray-1 data-[checked]:bg-blue-5 data-[focus]:ring-blue-5 ',
        'dark:bg-dark-5 dark:text-white dark:ring-dark-4 dark:hover:bg-dark-4 dark:data-[checked]:bg-blue-8 dark:data-[focus]:ring-blue-8 '
      )}
    >
      {label}
    </Radio>
  );
}

function getUpscaleSizes({
  width,
  height,
  target,
}: {
  width: number;
  height: number;
  target: number;
}) {
  const aspectRatio = width / height;
  let upscaleWidth: number;
  let upscaleHeight: number;
  if (width > height) {
    upscaleWidth = target;
    upscaleHeight = Math.round(target / aspectRatio);
  } else {
    upscaleWidth = target * aspectRatio;
    upscaleHeight = target;
  }

  return {
    upscaleWidth: Math.ceil(upscaleWidth / 64) * 64,
    upscaleHeight: Math.ceil(upscaleHeight / 64) * 64,
  };
}
