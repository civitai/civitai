/** Mirrors `UserBuzz` in `user-account.service.ts`. */
export type BuzzBalance = {
  balance: number;
  lifetimeBalance: number;
  /** Null when the colour-balance read failed; yellow survives on its own. */
  blue: number | null;
  green: number | null;
  blueLifetime: number | null;
  greenLifetime: number | null;
} | null;

export async function fetchBuzzBalance(userId: number): Promise<BuzzBalance> {
  const r = await fetch(`/api/user-buzz-balance/${userId}`);
  if (!r.ok) throw new Error(String(r.status));
  return r.json();
}
