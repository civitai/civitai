import { useMemo } from 'react';
import { highlightInappropriate, includesInappropriate } from '~/utils/metadata/audit';

export default function PromptHighlight({
  prompt,
  children,
}: {
  prompt: string | undefined;
  children?: (ctx: { html: string; includesInappropriate: boolean }) => JSX.Element;
}) {
  const ctx = useMemo(() => {
    return {
      includesInappropriate: includesInappropriate(prompt),
      html: highlightInappropriate(prompt) ?? prompt ?? '',
    };
  }, [prompt]);

  if (children) return children(ctx);
  return <span dangerouslySetInnerHTML={{ __html: ctx.html }} />;
}
