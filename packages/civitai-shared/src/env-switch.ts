/**
 * An environment OFF-switch for a behaviour that is ON by default. `off`, `0` or `false` (any
 * case, surrounding whitespace ignored) turns it off. Anything else, including unset or empty,
 * leaves it on, so a typo can never silently disable a safety behaviour.
 */
export function isEnvSwitchOff(value: string | null | undefined): boolean {
  return value != null && /^(off|0|false)$/i.test(value.trim());
}

/** The inverse of `isEnvSwitchOff`: whether the default-on behaviour is enabled. */
export function isEnvSwitchOn(value: string | null | undefined): boolean {
  return !isEnvSwitchOff(value);
}
