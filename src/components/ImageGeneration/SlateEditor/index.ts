// This example is for an Editor with `ReactEditor` and `HistoryEditor`
import { BaseEditor, Descendant } from 'slate';
import { ReactEditor } from 'slate-react';
import { HistoryEditor } from 'slate-history';
import { ModelType } from '@prisma/client';

export type CustomEditor = BaseEditor & ReactEditor & HistoryEditor;

export type ParagraphElement = {
  type: 'paragraph';
  align?: string;
  children: Descendant[];
};

export type MentionElement = {
  type: 'mention';
  character: string;
  children: CustomText[];
};

export type ModelElement = {
  type: 'model';
  name: string;
  strength?: string;
  modelType: ModelType;
  children: CustomText[];
};

export type CustomElement = ParagraphElement | MentionElement | ModelElement;

export type FormattedText = {
  text: string;
  bold?: boolean;
  code?: boolean;
  italic?: boolean;
  underline?: boolean;
};

export type CustomText = FormattedText;

declare module 'slate' {
  interface CustomTypes {
    Editor: CustomEditor;
    Element: CustomElement;
    Text: CustomText;
  }
}
