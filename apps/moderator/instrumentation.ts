// Intentionally empty. In this pnpm monorepo, Next 16 infers the repo root as the
// workspace root and would otherwise pick up the MAIN app's src/instrumentation.* (which
// import ~/server/* main-app code). Providing our own shadows that. Add real OTEL setup
// here if/when this app needs it.
export function register() {}
