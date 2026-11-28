export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Log that we're in the instrumentation hook
    console.log('[instrumentation] Running in nodejs runtime');

    // Import the Node.js-specific instrumentation
    // This dynamic import of a LOCAL file is properly traced by Next.js
    await import('./instrumentation.node');

    // The moderation adapter registry sets the applier text scan uses for its verdicts
    // (text-scan/verdict-applier.ts); text scan no longer imports the registry itself. A failure
    // here must not stop the server: an unset applier logs each verdict it could not apply.
    try {
      await import('~/server/services/moderation-adapters');
    } catch (error) {
      console.error('[instrumentation] moderation adapters failed to load', error);
    }
  }
}
