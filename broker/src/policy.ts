// The declarative cap table. Adding a future service = one secret in the
// vault, one row here, one proxy module. Caps are per UTC day.
export interface Policy { capPerDay: number | null }

export const POLICY: Readonly<Record<string, Readonly<Policy>>> = Object.freeze({
  'mail.send':   Object.freeze({ capPerDay: 20 }),
  'mail.list':   Object.freeze({ capPerDay: null }),
  'mail.read':   Object.freeze({ capPerDay: null }),
  'mail.health': Object.freeze({ capPerDay: null }),
});

export function policyFor(service: string, verb: string): Policy | undefined {
  return POLICY[`${service}.${verb}`];
}
