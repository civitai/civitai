// Shared because the server sizes its fetch from this and the client slices the render by it.
export const HOME_BLOCK_ITEMS_PER_ROW = 7;

// Not 'default': entries under that key predate the PG cap and must never be read again.
export const FEATURED_MODELS_HOME_BLOCK_KEY = 'pg';
