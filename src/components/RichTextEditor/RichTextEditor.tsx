import dynamic from 'next/dynamic';

const RichTextEditor = dynamic(() =>
  import('~/components/RichTextEditor/RichTextEditorComponent').then((x) => x.RichTextEditor)
);

export { RichTextEditor };
