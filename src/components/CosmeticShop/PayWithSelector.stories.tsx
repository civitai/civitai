import { useState } from 'react';
import type { PayWithOption } from '~/components/CosmeticShop/PayWithSelector';
import { PayWithSelector } from '~/components/CosmeticShop/PayWithSelector';
import type { BuzzSpendType } from '~/shared/constants/buzz.constants';

function Preview({
  initial = 'default',
  domainType = 'yellow',
}: {
  initial?: PayWithOption;
  domainType?: BuzzSpendType;
}) {
  const [value, setValue] = useState<PayWithOption>(initial);
  return (
    <div style={{ width: 330, minHeight: 150 }}>
      <PayWithSelector value={value} onChange={setValue} domainType={domainType} />
    </div>
  );
}

/** Yellow domain, domain color selected (default state) */
export const Default = () => <Preview />;

/** Blue + Yellow selected */
export const BothSelected = () => <Preview initial="blue-first" />;

/** Green domain (civitai.green) */
export const GreenDomain = () => <Preview domainType="green" />;
