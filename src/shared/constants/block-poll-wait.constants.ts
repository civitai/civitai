/**
 * The largest `waitSeconds` the poll wire schemas accept (`blocks.pollWorkflow` and its REST twin).
 * It only rejects nonsense; the hold actually granted is `MAX_BLOCK_POLL_WAIT_SECONDS`, server-side.
 *
 * Shared because the host bridge caps to it before forwarding: a value the schema refuses fails the
 * poll, and a failed poll reaches the block as a failed generation. Dependency-free, so browser code
 * can import it.
 */
export const BLOCK_POLL_WAIT_SECONDS_WIRE_MAX = 60;
