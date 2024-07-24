import { useMemo } from 'react';
import { highlightInappropriate, includesInappropriate } from '~/utils/metadata/audit';
import { normalizeText } from '~/utils/normalize-text';

export default function PromptHighlight({
  prompt,
  negativePrompt,
  children,
}: {
  prompt: string | undefined;
  negativePrompt?: string;
  children?: (ctx: { html: string; includesInappropriate: boolean }) => JSX.Element;
}) {
  const ctx = useMemo(() => {
    const input = { prompt: normalizeText(prompt), negativePrompt: normalizeText(negativePrompt) };
    return {
      includesInappropriate: includesInappropriate(input) !== false,
      html: highlightInappropriate(input) ?? input.prompt ?? '',
    };
  }, [prompt, negativePrompt]);

  if (children) return children(ctx);
  return <span dangerouslySetInnerHTML={{ __html: ctx.html }} />;
}
