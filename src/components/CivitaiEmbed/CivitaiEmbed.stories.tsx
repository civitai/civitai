import { EmbedRow, MatureTile, UnavailableTile } from '~/components/CivitaiEmbed/CivitaiEmbedBlock';

// The real ModelCard/ImageCard need the app's providers; a block the size of a feed card stands in.
function StandInCard({ label }: { label: string }) {
  return (
    <div className="flex aspect-[7/9] w-full items-end rounded-md bg-gradient-to-br from-blue-6 to-violet-8 p-3 text-sm font-bold text-white">
      {label}
    </div>
  );
}

function Article({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ width: 'min(900px, calc(100vw - 32px))' }}>
      <p>An article paragraph above the cards.</p>
      {children}
      <p>And one below.</p>
    </div>
  );
}

export const RowOfThree = () => (
  <Article>
    <EmbedRow count={3}>
      <StandInCard label="ModelCard (feed component)" />
      <MatureTile type="model" onShow={() => undefined} />
      <UnavailableTile item={{ type: 'image', id: 3 }} />
    </EmbedRow>
  </Article>
);

export const Single = () => (
  <Article>
    <EmbedRow count={1}>
      <StandInCard label="ModelCard (feed component)" />
    </EmbedRow>
  </Article>
);

export const Mature = () => (
  <Article>
    <EmbedRow count={1}>
      <MatureTile type="model" onShow={() => undefined} />
    </EmbedRow>
  </Article>
);

export const Unavailable = () => (
  <Article>
    <EmbedRow count={1}>
      <UnavailableTile item={{ type: 'model', id: 12, versionId: 99 }} />
    </EmbedRow>
  </Article>
);
