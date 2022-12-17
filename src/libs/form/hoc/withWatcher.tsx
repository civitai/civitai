import { useDidUpdate } from '@mantine/hooks';
import { useCallback, useState, useEffect } from 'react';
import { DeepPartial, FieldValues, UnpackNestedValue, useFormContext } from 'react-hook-form';

type WatcherBaseProps = {
  visible?: (values: Record<string, unknown>) => boolean;
};

export function withWatcher<
  TComponentProps extends { onChange?: (...events: any[]) => void } & Record<string, any> //eslint-disable-line
>(
  BaseComponent:
    | React.ForwardRefExoticComponent<TComponentProps>
    | ((props: TComponentProps) => JSX.Element)
) {
  function WatchWrapper({ visible, ...props }: TComponentProps & WatcherBaseProps) {
    if (!visible) return <BaseComponent {...(props as TComponentProps)} />;
    return (
      <Watcher visible={visible}>
        <BaseComponent {...(props as TComponentProps)} />
      </Watcher>
    );
  }
  return WatchWrapper;
}

type Props = WatcherBaseProps & {
  children: JSX.Element;
};

export function WatchWrapper({ visible, children }: Props) {
  if (!visible) return children;
  return <Watcher visible={visible}>{children}</Watcher>;
}

export function Watcher({ visible, children }: Required<Props>) {
  const { watch, getValues } = useFormContext<FieldValues>() ?? {};

  const handleVisible = useCallback(() => {
    const values = getValues?.() as UnpackNestedValue<DeepPartial<FieldValues>>;
    return visible(values);
  }, [getValues, visible]);

  const [show, setShow] = useState<boolean>(handleVisible);

  useDidUpdate(() => {
    setShow(handleVisible());
  }, [handleVisible]);

  useEffect(() => {
    const subscription = watch?.((value, { name, type }) => {
      if (!name || !type) return;
      setShow(visible(value));
    });
    return () => subscription?.unsubscribe();
  }, [watch, visible]);

  // useEffect(() => console.log('visible changed'), [handleVisible]);
  // useEffect(() => console.log(`show changed: ${show}`), [show]);

  return show ? children : null;
}
