// The tour step's target, the footer's blocked-target check, and the button's
// own data-tour attribute must all agree on this key, or the tour strands the
// user on a disabled button — kept out of the tours directory so importing it
// never drags the step arrays' deps along.
export const GEN_SUBMIT_KEY = 'gen:submit';
export const GEN_SUBMIT_TARGET = `[data-tour="${GEN_SUBMIT_KEY}"]`;
