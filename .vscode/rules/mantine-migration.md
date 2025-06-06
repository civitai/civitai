# Mantine Migration Guide

This document outlines the breaking changes when migrating Mantine from version 5 to 6 and from version 6 to 7.

## 🧨 Mantine v5 → v6 Breaking Changes

### 📅 Date & Time Components

- Renamed Components:
  - `DatePicker` → `DatePickerInput`
  - `Calendar` → `DatePicker`
- Removed Components:
  - `TimeRangeInput`
  - `DateRangePicker`
  - `RangeCalendar`
- Updated Components:
  - `TimeInput` now uses native `<input type="time">`
- Prop Changes:
  - `amountOfMonths` → `numberOfColumns`
  - `allowFreeInput` removed; use `DateInput` instead
  - `dayClassName` and `dayStyle` removed; use `getDayProps`

### 🎨 Theme Object Adjustments

- Removed from theme:
  - `dateFormat`, `datesLocale`
- Prop Renames:
  - `withFocusReturn` → `returnFocus`
  - `overflow` → `scrollAreaComponent`
  - `overlayBlur` → `overlayProps.blur`
  - `overlayColor` → `overlayProps.color`
  - `overlayOpacity` → `overlayProps.opacity`
  - `exitTransitionDuration` → `transitionProps.exitDuration`
  - `transition` → `transitionProps.transition`
  - `transitionDuration` → `transitionProps.duration`
  - `transitionTimingFunction` → `transitionProps.timingFunction`

### 🧮 NumberInput Component

- Props now expect `number | ''` instead of `number | undefined`

### 🔢 Pagination Component

- Prop Changes:
  - `itemComponent`, `getItemAriaLabel` removed; use `getItemProps`
  - `initialPage` → `defaultValue`
  - `page` → `value`

### 🔍 Spotlight Component

- Now based on `Modal`
- Prop Renames follow same pattern as above

### 🧪 Input Components

- `invalid` prop → `error`
- Styles API updated: use `data-*` attributes

## 🚨 Mantine v6 → v7 Breaking Changes

### 🎨 Styling Overhaul

- Removed:
  - `createStyles` function
  - Nested selectors in `sx`, `styles` props
- Recommendations:
  - Use CSS Modules or `className`, `style` props
  - Use `postcss-preset-mantine` for advanced styling

### 🧩 @mantine/emotion Package

- Optional package to restore `createStyles` and `sx` behavior during migration

## 🛠 Migration Tips

- Transition to CSS Modules or Tailwind classes
- Use `@mantine/emotion` for interim compatibility
- Review and test each component after migration
- Use Tailwind CSS instead of Mantine `createStyles` or `sx` props.
- Remove all `createStyles` usage. Convert styles to Tailwind classNames directly on components.
- If a Mantine component has an `sx` or `classNames` prop, replace it with a `className` using Tailwind.
- Keep using Mantine components, but prefer native HTML elements when simpler.
- Use Tailwind utility classes for spacing, layout, colors, and typography.
- Avoid inline styles. Use Tailwind whenever possible.
- Assume Tailwind config includes custom colors and spacing aligned with Mantine theme.
- Do not suggest Emotion or styled-components. Tailwind is the preferred styling method.
- Treat Mantine components as unstyled when possible — all visuals handled by Tailwind.

## 📚 References

- https://v6.mantine.dev/changelog/6-0-0/
- https://v7.mantine.dev/guides/6x-to-7x/
- https://v6.mantine.dev/pages/basics/
- https://v7.mantine.dev/overview/
