/**
 * The most workflow bodies ONE batch estimate (`ESTIMATE_WORKFLOW_BATCH` →
 * `blocks.estimateWorkflowBatch`) may carry.
 *
 * 16 is the grid the platform's own fan-out guidance is written around: the
 * developer guide's "Running many generations" section sizes every per-viewer
 * limit against a 4×4 grid and concludes that 16 cells in one go is inside all of
 * them. A cap equal to that grid lets the documented case through in one call
 * while keeping the per-call multiplier on upstream cost quotes as small as the
 * documented case allows. A larger grid is priced in several calls.
 *
 * 🔴 ONE CONSTANT, TWO READERS. The host's request parser refuses a longer list
 * before any round trip, and the server's input schema refuses it again. A parser
 * that allowed more than the server accepts would turn every over-long list into
 * a server validation error for the whole call; one that allowed fewer would
 * silently narrow the feature. Both import this.
 *
 * Dependency-free on purpose: it is imported by browser code, so it must not pull
 * the workflow body schema (and the step registry behind it) into a client bundle.
 */
export const BLOCK_ESTIMATE_BATCH_MAX_CELLS = 16;
