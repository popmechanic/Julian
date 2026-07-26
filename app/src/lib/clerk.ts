import { Clerk } from '@clerk/clerk-js';

let clerk: Clerk | null = null;

export async function initClerk(): Promise<void> {
  const pk = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
  if (!pk) return; // local dev without Clerk — server also skips auth in this mode
  clerk = new Clerk(pk);
  await clerk.load();
}
export function isSignedIn(): boolean { return !!clerk?.user; }
export async function getToken(): Promise<string | null> {
  if (!clerk?.session) return null;
  return clerk.session.getToken();
}
export function clerkInstance(): Clerk | null { return clerk; }
