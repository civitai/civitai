export default function Home() {
  return (
    <main style={{ maxWidth: 720, margin: '0 auto', padding: '64px 24px' }}>
      <h1 style={{ marginBottom: 8 }}>Civitai Moderator</h1>
      <p style={{ color: '#666', marginTop: 0, fontSize: 18 }}>
        Welcome. This is the moderator app — a Next.js 16 app in <code>apps/moderator</code>,
        running inside the Civitai monorepo.
      </p>
      <p style={{ color: '#888' }}>
        It&apos;s wired to the shared <code>@civitai/*</code> packages (DB, Redis, &hellip;)
        through their factories — see <code>lib/db.ts</code> — ready for moderation pages to be
        built on top.
      </p>
    </main>
  );
}
