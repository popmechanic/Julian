// The declarative cap table. Adding a future service = one secret in the
// vault, one row here, one proxy module. Caps are per UTC day.
export interface Policy { capPerDay: number | null }

export const POLICY: Record<string, Policy> = {
  'mail.send':   { capPerDay: 20 },
  'mail.list':   { capPerDay: null },
  'mail.read':   { capPerDay: null },
  'mail.health': { capPerDay: null },
};

export function policyFor(service: string, verb: string): Policy | undefined {
  return POLICY[`${service}.${verb}`];
}
