export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    // Log that we're in the instrumentation hook
    console.log('[instrumentation] Running in nodejs runtime');

    // Import the Node.js-specific instrumentation
    // This dynamic import of a LOCAL file is properly traced by Next.js
    await import('./instrumentation.node');
  }
}
