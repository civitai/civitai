import { useForm, Form } from '~/libs/form';
import { QuestionDetail } from '~/server/controllers/question.controller';

export function QuestionForm({ question }: { question?: QuestionDetail }) {
  const form = useForm();

  return <Form form={form}></Form>;
}
