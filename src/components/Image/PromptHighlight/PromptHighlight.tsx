import { useMemo } from 'react';
import { highlightInappropriate, includesInappropriate } from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/string-helpers';

export default function PromptHighlight({
  prompt,
  children,
}: {
  prompt: string | undefined;
  children?: (ctx: { html: string; includesInappropriate: boolean }) => JSX.Element;
}) {
  const ctx = useMemo(() => {
    const cleaned = normalizeText(prompt);
    return {
      includesInappropriate: includesInappropriate(cleaned) !== false,
      html: highlightInappropriate(cleaned) ?? cleaned ?? '',
    };
  }, [prompt]);

  if (children) return children(ctx);
  return <span dangerouslySetInnerHTML={{ __html: ctx.html }} />;
}
