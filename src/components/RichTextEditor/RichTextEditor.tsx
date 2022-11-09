// RichText.tsx in your components folder
import { Box, Input, InputWrapperProps } from '@mantine/core';
import { RichTextEditorProps } from '@mantine/rte';
import dynamic from 'next/dynamic';

const DynamicRichTextEditor = dynamic(() => import('@mantine/rte'), {
  // Disable during server side rendering
  ssr: false,

  // Render anything as fallback on server, e.g. loader or html content without editor
  loading: () => null,
});

export function RichTextEditor({ id, label, description, withAsterisk, error, ...props }: Props) {
  return (
    <Input.Wrapper
      id={id}
      label={label}
      description={description}
      withAsterisk={withAsterisk}
      error={error}
    >
      <Box mt={description ? 5 : undefined}>
        <DynamicRichTextEditor
          id={id}
          controls={[
            ['bold', 'italic', 'underline', 'strike', 'clean'],
            ['unorderedList', 'orderedList'],
            ['link'],
          ]}
          {...props}
        />
      </Box>
    </Input.Wrapper>
  );
}

type Props = RichTextEditorProps &
  Pick<InputWrapperProps, 'label' | 'description' | 'withAsterisk' | 'error'>;
