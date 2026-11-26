import { describe, expect, it } from 'vitest';
import { MAX_TOOL_OUTPUT_CHARS, transcriptView } from '~/shared/app-assistant/transcript-view';

const CHAT = {
  conversationId: 'conv-view',
  title: 'Sticker maker',
  model: 'model-view-b',
  turns: [
    {
      seq: 1,
      createdAt: '2026-11-20T09:00:00.000Z',
      user: { content: 'Make a sticker maker', attachments: [] },
      assistant: {
        status: 'done',
        buzz: 7,
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'reasoning', text: 'Think first.' },
              { type: 'text', text: 'On it.' },
              { type: 'tool-call', toolCallId: 't1', toolName: 'read_docs', input: { url: 'u' } },
              {
                type: 'tool-call',
                toolCallId: 't2',
                toolName: 'sandbox__run_command',
                input: { command: 'x' },
              },
              { type: 'tool-call', toolCallId: 't3', toolName: 'create_app', input: {} },
            ],
          },
          {
            role: 'tool',
            content: [
              {
                type: 'tool-result',
                toolCallId: 't1',
                output: { type: 'text', value: 'abcdefghij' },
              },
              {
                type: 'tool-result',
                toolCallId: 't2',
                output: { type: 'error-text', value: 'exit 1' },
              },
            ],
          },
          { role: 'assistant', content: 'Done.' },
        ],
      },
    },
    {
      seq: 2,
      user: { content: [{ type: 'text', text: 'Again' }] },
      assistant: { status: 'error', error: 'It broke', messages: [] },
    },
  ],
};

describe('transcriptView', () => {
  it('renders each turn’s words, reasoning, text and tool calls in order, outputs cut', () => {
    expect(transcriptView(CHAT, { toolOutputChars: 4 })).toEqual({
      conversationId: 'conv-view',
      title: 'Sticker maker',
      model: 'model-view-b',
      turns: [
        {
          seq: 1,
          createdAt: '2026-11-20T09:00:00.000Z',
          user: 'Make a sticker maker',
          status: 'done',
          buzz: 7,
          error: null,
          steps: [
            { kind: 'reasoning', text: 'Think first.' },
            { kind: 'text', text: 'On it.' },
            {
              kind: 'tool',
              tool: 'read_docs',
              toolCallId: 't1',
              input: { url: 'u' },
              output: 'abcd',
              outputTruncated: true,
              isError: false,
            },
            {
              kind: 'tool',
              tool: 'sandbox__run_command',
              toolCallId: 't2',
              input: { command: 'x' },
              output: 'exit',
              outputTruncated: true,
              isError: true,
            },
            // No result saved (cut off): an error with no output.
            {
              kind: 'tool',
              tool: 'create_app',
              toolCallId: 't3',
              input: {},
              output: '',
              outputTruncated: false,
              isError: true,
            },
            { kind: 'text', text: 'Done.' },
          ],
        },
        {
          seq: 2,
          createdAt: null,
          user: 'Again',
          status: 'error',
          buzz: null,
          error: 'It broke',
          steps: [],
        },
      ],
    });
  });

  it('never cuts beyond the cap, and reads garbage as an empty transcript', () => {
    const long = 'z'.repeat(MAX_TOOL_OUTPUT_CHARS + 10);
    const chat = {
      ...CHAT,
      turns: [
        {
          seq: 1,
          user: { content: 'x' },
          assistant: {
            messages: [
              {
                role: 'assistant',
                content: [{ type: 'tool-call', toolCallId: 'l', toolName: 'big', input: {} }],
              },
              {
                role: 'tool',
                content: [
                  { type: 'tool-result', toolCallId: 'l', output: { type: 'text', value: long } },
                ],
              },
            ],
          },
        },
      ],
    };
    const step = transcriptView(chat, { toolOutputChars: 10 ** 9 }).turns[0]!.steps[0]!;
    expect(step.output).toHaveLength(MAX_TOOL_OUTPUT_CHARS);
    expect(step.outputTruncated).toBe(true);
    expect(transcriptView(null)).toEqual({
      conversationId: '',
      title: null,
      model: null,
      turns: [],
    });
  });
});
