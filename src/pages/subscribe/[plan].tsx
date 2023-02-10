import { useRouter } from 'next/router';
import { z } from 'zod';

const plans = [
  {
    planId: 'prod_NBPmYQLea2ME6r',
    apiId: 'price_1MR2wXAFgdjIzMi0688o9zS7',
    name: 'Supporter Tier',
    price: 10,
    interval: 'month',
    slug: 'supporter-tier',
  },
  {
    planId: 'prod_NBPmrtDsD8KBXV',
    apiId: 'price_1MR2xDAFgdjIzMi0g582EUrD',
    name: 'Tier 2',
    price: 10,
    interval: 'month',
    slug: 'tier-2',
  },
];

type Plan = typeof plans[0];

const schema = z.object({
  session_id: z.string().optional(),
  success: z.string().optional(),
  canceled: z.string().optional(),
});

export default function Subscribe() {
  const router = useRouter();
  const slug = router.query.plan as string;
  const plan = plans.find((x) => x.slug === slug) ?? plans[0];
  const { session_id, success, canceled } = schema.parse(router.query);

  if (!success && !canceled) return <ProductDisplay plan={plan} />;
  else if (success && session_id) return <SuccessDisplay sessionId={session_id} plan={plan} />;
  else
    return (
      <section>
        <p>Order canceled</p>
      </section>
    );
}

function ProductDisplay({ plan }: { plan: Plan }) {
  return (
    <section>
      <div className="product">
        <div className="description">
          <Logo />
          <h3>{plan.name}</h3>
          <h5>
            ${plan.price} / {plan.interval}
          </h5>
        </div>
      </div>
      <form action="/create-checkout-session" method="POST">
        {/* Add a hidden field with the lookup_key of your Price */}
        <input type="hidden" name="lookup_key" value={plan.apiId} />
        <button id="checkout-and-portal-button" type="submit">
          Checkout
        </button>
      </form>
    </section>
  );
}

function SuccessDisplay({ sessionId, plan }: { sessionId: string; plan: Plan }) {
  return (
    <section>
      <div className="product Box-root">
        <Logo />
        <div className="description Box-root">
          <h3>Subscription to {plan.name} successful!</h3>
        </div>
      </div>
      <form action="/create-portal-session" method="POST">
        <input type="hidden" id="session-id" name="session_id" value={sessionId} />
        <button id="checkout-and-portal-button" type="submit">
          Manage your billing information
        </button>
      </form>
    </section>
  );
}

const Logo = () => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    xmlnsXlink="http://www.w3.org/1999/xlink"
    width="14px"
    height="16px"
    viewBox="0 0 14 16"
    version="1.1"
  >
    <defs />
    <g id="Flow" stroke="none" strokeWidth="1" fill="none" fillRule="evenodd">
      <g id="0-Default" transform="translate(-121.000000, -40.000000)" fill="#E184DF">
        <path
          d="M127,50 L126,50 C123.238576,50 121,47.7614237 121,45 C121,42.2385763 123.238576,40 126,40 L135,40 L135,56 L133,56 L133,42 L129,42 L129,56 L127,56 L127,50 Z M127,48 L127,42 L126,42 C124.343146,42 123,43.3431458 123,45 C123,46.6568542 124.343146,48 126,48 L127,48 Z"
          id="Pilcrow"
        />
      </g>
    </g>
  </svg>
);
