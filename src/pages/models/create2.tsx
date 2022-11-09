import { useSession } from 'next-auth/react';
import { ModelForm2 } from '~/components/Model/ModelForm/ModelForm2';

export default function Create2() {
  const { data: session } = useSession();
  console.log({ session });
  return <ModelForm2 />;
}
