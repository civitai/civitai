// The tour step's target, the footer's blocked-target check, and the button's
// own data-tour attribute must all agree on this key, or the tour strands the
// user on a disabled button — kept out of the tours directory so importing it
// never drags the step arrays' deps along.
export const GEN_SUBMIT_KEY = 'gen:submit';
export const GEN_SUBMIT_TARGET = `[data-tour="${GEN_SUBMIT_KEY}"]`;

// Both keys belong to the generator's own footer. `gen:buzz` lived on the shared
// `BuzzTransactionButton` until 8f220ff3c6 took that component out of the footer, and
// then resolved nowhere for five months while still reading as declared.
export const GEN_BUZZ_KEY = 'gen:buzz';
export const GEN_BUZZ_TARGET = `[data-tour="${GEN_BUZZ_KEY}"]`;
