import { Button, Card, Text, Title } from '@mantine/core';
import { z } from 'zod';
import { useMarketplaceContext } from '~/components/Marketplace/MarketplaceProvider';
import { Form, InputNumber, useForm } from '~/libs/form';
import { formatCurrencyForDisplay } from '~/utils/number-helpers';

const minBuzzAmount = 1000; // Minimum amount of Buzz to list for sale

const schema = z.object({
  amount: z.number().min(minBuzzAmount, 'Minimum amount is 1000 Buzz'),
  price: z.number().min(0.01, 'Price must be greater than 0'),
  currency: z.enum(['USD', 'EUR', 'GBP']),
});

export function ListBuzzSale() {
  const { currency } = useMarketplaceContext();
  const form = useForm({ schema });

  const handleSubmit = (data: z.input<typeof schema>) => {
    console.log(data);
  };

  const [amount = 0, price = 0] = form.watch(['amount', 'price']);
  const totalValue = (amount / 10) * price; // Total value in the selected currency
  const totalPrice = formatCurrencyForDisplay(totalValue, currency, { decimals: true });

  return (
    <Card className="flex flex-col" aria-label="List Buzz for Sale" radius="md" withBorder>
      <Title order={2} className="mb-2 text-lg font-semibold">
        List Buzz for Sale
      </Title>
      <Form className="flex flex-col gap-4" form={form} onSubmit={handleSubmit}>
        <InputNumber name="amount" label="Amount" step={minBuzzAmount} min={minBuzzAmount} />
        <InputNumber name="price" label="Price per thousand" step={0.01} min={0.01} />
        <Text size="sm">
          Total value:{' '}
          <Text fw="bold" span>
            ${totalPrice}
          </Text>
        </Text>
        <Button type="submit" disabled={!totalValue} fullWidth>
          Post Listing - ${totalPrice}
        </Button>
        <Text size="xs" c="dimmed">
          Buzz is deducted immediately. Canceling listings costs 100 Buzz
        </Text>
      </Form>
    </Card>
  );
}
