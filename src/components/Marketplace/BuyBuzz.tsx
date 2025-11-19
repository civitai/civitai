import { Anchor, Button, Card, Paper, Text, Title } from '@mantine/core';
import { z } from 'zod/v4';
import { useMarketplaceContext } from '~/components/Marketplace/MarketplaceProvider';
import { Form, InputNumber, InputSelect, useForm } from '~/libs/form';
import { MarketplacePaymentMethod } from '~/server/common/enums';

const minBuzzAmount = 1000; // Minimum amount of Buzz to list for sale
const availablePaymentMethods = Object.values(MarketplacePaymentMethod);

const schema = z.object({
  amount: z.number().min(minBuzzAmount, 'Minimum amount is 1000 Buzz'),
  paymentMethod: z.enum(MarketplacePaymentMethod),
  currency: z.enum(['USD', 'EUR', 'GBP']),
});

export function BuyBuzz() {
  const { currency } = useMarketplaceContext();
  const form = useForm({ schema });

  const handleSubmit = (data: z.input<typeof schema>) => {
    console.log(data, currency);
  };

  const [amount = 0] = form.watch(['amount']);
  // const totalValue = (amount / 10) * price; // Total value in the selected currency
  // const totalPrice = formatCurrencyForDisplay(totalValue, currency, { decimals: true });

  return (
    <Card className="flex flex-col" radius="md" withBorder>
      <Title order={2} className="mb-2 text-lg font-semibold">
        Buy Buzz
      </Title>
      <Form className="flex flex-col gap-4" form={form} onSubmit={handleSubmit}>
        <InputNumber
          name="amount"
          label="Amount to purchase"
          step={minBuzzAmount}
          min={minBuzzAmount}
        />
        <InputSelect name="paymentMethod" label="Payment Method" data={availablePaymentMethods} />
        <Paper className="flex h-12 items-center justify-center" withBorder>
          Best match goes here
        </Paper>
        <Button type="submit" disabled={!amount} fullWidth>
          Proceed to Purchase
        </Button>
      </Form>
    </Card>
  );
}
