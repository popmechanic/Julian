# Work in Progress — PWA Parity Audit

Service worker (`sw.js`) is active and registered, but the installed PWA version can diverge from the browser URL version. This documents the gaps and what needs to change.

---

## Critical

- **`bundles/fireproof-clerk-bundle.js` cached without versioning** — Deploys serve stale bundle until `CACHE_NAME` is manually bumped in `sw.js`. Users who installed the PWA get the old bundle indefinitely.
- **No SW update notification** — Users are stuck on old app version until the browser's ~24h automatic update check fires. No `updatefound`/`controllerchange` listener, no reload prompt.
- **`@tailwindcss/browser@4` unpinned** — Cached at whatever version was first loaded from `esm.sh`. Never updates unless cache is cleared.

## High

- **Clerk popup sign-in may fail in standalone PWA mode** — On iOS, popups from a standalone PWA open in the system browser, breaking the OAuth redirect back to the app.
- **PWA meta tags injected via React `useEffect`** — iOS reads `<meta>` tags at HTML parse time. Injecting them from JS means `apple-mobile-web-app-capable`, status bar style, and other iOS-specific tags are ignored.

## Moderate

- **Manifest scope implicitly `/assets/icons/`** — No explicit `"scope": "/"` in `manifest.json`, leading to potential scope mismatch if the manifest URL changes.
- **No offline fallback UI** — Raw fetch errors surface when offline. No user-facing "you're offline" state.
- **`esm.sh` chain-loads sub-dependencies not in import map** — First offline open after install breaks because transitive deps were never cached.

---

## What Already Works

- `/api/*` routes correctly pass through (no caching) — SSE, auth, chat all work
- Navigation is network-first — page loads hit server when online
- All fetch URLs are relative — no hardcoded domains

---

## Fixes Needed for Full Parity

- [ ] **SW update detection** — Listen for `updatefound`/`controllerchange`, prompt user to reload
- [ ] **Cache-bust `bundles/fireproof-clerk-bundle.js`** — Content hash in filename or query string
- [ ] **Pin Tailwind CDN** to specific patch version (e.g. `@tailwindcss/browser@4.1.8`)
- [ ] **Handle Clerk auth in standalone mode** — Detect `display-mode: standalone` media query, use redirect-based auth instead of popup
- [ ] **Move PWA meta tags to static HTML `<head>`** — Remove `useEffect` injection, hardcode in `index.html`
- [ ] **Set explicit `"scope": "/"`** in `manifest.json`
- [ ] **Add basic offline detection UI** — Show banner or overlay when `navigator.onLine` is false
