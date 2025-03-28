import GameErrorBoundary from '~/components/Games/GameErrorBoundary';
import { useKnightsNewOrderListener } from '~/components/Games/KnightsNewOrder.utils';

export default function KnightsNewOrderPage() {
  useKnightsNewOrderListener();

  return (
    <GameErrorBoundary>
      <div>
        <h1>Knights of New Order</h1>
        <p>Welcome to page Knights New Order</p>
      </div>
    </GameErrorBoundary>
  );
}
