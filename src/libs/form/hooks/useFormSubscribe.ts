import { FieldValues, WatchObserver, useFormContext } from 'react-hook-form';
import { useEffect } from 'react';

export function useFormSubscribe(callback: WatchObserver<FieldValues>) {
  const form = useFormContext();

  useEffect(() => {
    const subscription = form.watch(callback);
    return subscription.unsubscribe;
  }, [form]);
}
