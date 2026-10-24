export const domainOf = (email: string | null) => email?.split('@')[1] ?? null;
