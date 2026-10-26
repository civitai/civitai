import type { InputWrapperProps, NumberInputProps } from '@mantine/core';
import { Group, Input, NumberInput, Text } from '@mantine/core';
import { IconAlertTriangle, IconMinus, IconPlus } from '@tabler/icons-react';
import clsx from 'clsx';
import { isValidElement, useEffect, useRef, useState } from 'react';
import type { CSSProperties, ReactNode } from 'react';
import { TouchSlider } from '~/components/generation_v2/inputs/TouchSlider';
import { snapToStep } from '~/components/generation_v2/inputs/touch-slider.utils';
import { useHoldRepeat } from '~/hooks/useHoldRepeat';
import { useMobileGenerator } from '~/hooks/useMobileGenerator';
import classes from './SliderInput.module.scss';

// =============================================================================
// Types
// =============================================================================

interface PresetOption {
  label: string;
  value: number;
}

export interface SliderInputProps extends Omit<InputWrapperProps, 'children' | 'onChange'> {
  value?: number;
  onChange?: (value: number) => void;
  min: number;
  max: number;
  step?: number;
  precision?: number;
  /** The accessible name, where there is no visible text label. */
  ariaLabel?: string;
  numberProps?: Omit<NumberInputProps, 'value' | 'onChange' | 'min' | 'max' | 'step' | 'precision'>;
  presets?: PresetOption[];
  disabled?: boolean;
  warning?: string;
  /** An advisory band painted on the track in place of the filled bar, so the thumb is a position, not an amount. */
  recommended?: { min: number; max: number };
  /** In the mobile generator: − and + buttons either side of the track, for fine values. */
  steppers?: boolean;
}

// =============================================================================
// Preset Options Component
// =============================================================================

interface PresetOptionsProps {
  options: PresetOption[];
  value?: number;
  onChange: (value: number) => void;
  disabled?: boolean;
}

function PresetOptions({ options, value, onChange, disabled }: PresetOptionsProps) {
  return (
    <Group gap={4}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          onClick={() => onChange(option.value)}
          disabled={disabled}
          className={clsx(
            'rounded px-2 py-0.5 text-xs transition-colors',
            value === option.value
              ? 'bg-blue-6 text-white'
              : 'bg-gray-1 text-gray-7 hover:bg-gray-2 dark:bg-dark-5 dark:text-gray-4 dark:hover:bg-dark-4'
          )}
        >
          {option.label}
        </button>
      ))}
    </Group>
  );
}

// The visible `label` sits on the wrapper and can't be associated with the inner controls, so
// they reuse its text as their accessible name. Handles a plain string and `<ControllerLabel />`.
function accessibleNameOf(label: ReactNode) {
  if (typeof label === 'string') return label;
  if (isValidElement(label) && typeof (label.props as { label?: unknown })?.label === 'string')
    return (label.props as { label: string }).label;
  return undefined;
}

// =============================================================================
// Component
// =============================================================================

/**
 * A slider with its value. One component for every layout: the mobile generator moves the presets
 * under the track, swaps the number box for a tap-to-type value and can add − / + steppers; its
 * touch sizes come from the mobile generator's stylesheet, not from here.
 */
export function SliderInput({
  value,
  onChange,
  min = 0,
  max = 100,
  step,
  precision: initialPrecision,
  ariaLabel,
  numberProps,
  presets,
  label,
  disabled,
  warning,
  recommended,
  steppers,
  className,
  ...inputWrapperProps
}: SliderInputProps) {
  const mobile = useMobileGenerator();
  const numberRef = useRef<HTMLInputElement>(null);
  const [numberWidth, setNumberWidth] = useState<string>();
  const [draft, setDraft] = useState<number>();
  const [editing, setEditing] = useState(false);

  const precision = initialPrecision ?? step?.toString().split('.')[1]?.length;
  const range = { min, max, step };
  const current = value ?? min;
  const shown = draft ?? current;
  const name = ariaLabel ?? accessibleNameOf(label);
  const format = (v: number) => (precision ? v.toFixed(precision) : String(v));
  const hasPresets = !!presets?.length;
  // A band that is a single value (CFG 1 for some turbo LoRAs) reads as that value, not a range.
  const recommendation =
    recommended &&
    (recommended.min === recommended.max
      ? `Recommended: ${format(recommended.min)}`
      : `Recommended: ${format(recommended.min)}–${format(recommended.max)}`);

  const commit = (next: number) => {
    setDraft(undefined);
    if (next !== value) onChange?.(next);
  };
  const decrease = useHoldRepeat(() => commit(snapToStep(current - (step ?? 1), range)));
  const increase = useHoldRepeat(() => commit(snapToStep(current + (step ?? 1), range)));

  useEffect(() => {
    if (numberRef.current) setNumberWidth(getComputedWidth(numberRef.current, min, max, precision));
  }, [min, max, precision, mobile]);

  const slider = (
    <TouchSlider
      className={clsx(classes.track, classes.grow)}
      value={shown}
      min={min}
      max={max}
      step={step}
      recommended={recommended}
      disabled={disabled}
      label={name}
      formatValue={format}
      onChange={setDraft}
      onChangeEnd={commit}
    />
  );

  const warningText = warning && (
    <Text size="xs" color="yellow" className="mt-1 flex items-center gap-1">
      <IconAlertTriangle size={14} />
      {warning}
    </Text>
  );

  if (!mobile) {
    return (
      <Input.Wrapper
        {...inputWrapperProps}
        label={
          hasPresets ? (
            <Group gap={8} className="w-full" justify="space-between" wrap="nowrap">
              {label}
              <PresetOptions
                disabled={disabled}
                options={presets}
                value={value}
                onChange={commit}
              />
            </Group>
          ) : (
            label
          )
        }
        className={clsx('flex flex-col', className)}
        styles={{ label: hasPresets ? { width: '100%', marginBottom: 5 } : undefined }}
      >
        <div className="flex items-center gap-2">
          {slider}
          <NumberInput
            ref={numberRef}
            aria-label={numberProps?.['aria-label'] ?? name}
            {...numberProps}
            className={clsx('min-w-[60px] flex-[0]', numberProps?.className)}
            style={{
              ...numberProps?.style,
              minWidth: (numberProps?.style as CSSProperties)?.minWidth ?? numberWidth,
            }}
            min={min}
            max={max}
            step={step}
            decimalScale={precision}
            value={shown}
            onChange={(typed) => {
              const next = typeof typed === 'string' ? parseFloat(typed) : typed;
              if (Number.isFinite(next)) commit(next);
            }}
            disabled={disabled}
          />
        </div>
        {warningText}
      </Input.Wrapper>
    );
  }

  const valueControl = editing ? (
    <NumberInput
      autoFocus
      {...numberProps}
      defaultValue={current}
      min={min}
      max={max}
      step={step}
      decimalScale={precision}
      inputMode="decimal"
      hideControls
      aria-label={name}
      className={classes.valueInput}
      styles={{ input: { minHeight: 44, fontSize: 16, textAlign: 'center' } }}
      onBlur={(e) => {
        const typed = parseFloat(e.currentTarget.value);
        if (Number.isFinite(typed)) commit(snapToStep(typed, range));
        setEditing(false);
        numberProps?.onBlur?.(e);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  ) : (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setEditing(true)}
      aria-label={`${name ?? 'Value'}: ${format(shown)}. Tap to type a value`}
      className={classes.value}
    >
      {format(shown)}
    </button>
  );

  return (
    <div className={clsx(classes.column, className)}>
      {steppers ? (
        <div className={classes.row}>
          <button
            type="button"
            aria-label={`Decrease ${name ?? 'value'}`}
            disabled={disabled || current <= min}
            className={classes.stepper}
            {...decrease}
          >
            <IconMinus size={18} stroke={2.2} />
          </button>
          {slider}
          {valueControl}
          <button
            type="button"
            aria-label={`Increase ${name ?? 'value'}`}
            disabled={disabled || current >= max}
            className={classes.stepper}
            {...increase}
          >
            <IconPlus size={18} stroke={2.2} />
          </button>
        </div>
      ) : (
        <>
          <div className={classes.label}>{label}</div>
          <div className={clsx(classes.row, classes.underLabel)}>
            {slider}
            {valueControl}
          </div>
        </>
      )}
      {recommendation && (
        <p className={classes.recommendation}>
          <span className={classes.recommendationDot} aria-hidden />
          {recommendation}
        </p>
      )}
      {hasPresets && (
        <div className={classes.presets}>
          {presets.map((preset) => (
            <button
              key={preset.value}
              type="button"
              disabled={disabled}
              onClick={() => commit(preset.value)}
              aria-pressed={current === preset.value}
              className={classes.preset}
            >
              <span className={classes.presetLabel}>{preset.label}</span>
              <span className={classes.presetValue}>{format(preset.value)}</span>
            </button>
          ))}
        </div>
      )}
      {warningText}
    </div>
  );
}

// =============================================================================
// Helpers
// =============================================================================

const getComputedWidth = (elem: HTMLInputElement, min: number, max: number, precision?: number) => {
  const stringValue = [min, max]
    .map((x) => (precision ? x.toFixed(precision) : x.toString()))
    .sort((a, b) => b.length - a.length)[0];
  let ch = stringValue.length;
  if (stringValue.includes('.')) ch = ch - 0.75;
  const computed = getComputedStyle(elem);
  return `calc(${ch}ch + ${computed.paddingLeft} + ${computed.paddingRight} + ${computed.borderLeftWidth} + ${computed.borderRightWidth} + 6px)`;
};
