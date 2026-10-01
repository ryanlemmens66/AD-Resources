/*
  AirDesk — offline shell worker.

  Purpose: a reload during a network outage still brings up the desk. Every
  dataset the desk needs offline — LZs and aerodromes, IFR routes, hospitals
  and capabilities, HEMS bases, huts, emergency resources, clinical guidance —
  is already inlined in the HTML, and the response calculation runs entirely on
  values the operator types. So caching the one HTML file is enough to keep all
  of that reachable with no network.

  SCOPE: same-origin navigations only.

  Nothing else is cached, deliberately. Map tiles, Firebase, TracPlus, the NZTA
  proxy and every Google endpoint go straight to the network on every request.
  A cached live-service response is stale operational data presented as
  current, which is worse than the layer being visibly empty. The in-app health
  chip (#airdesk-health) already reports each live subsystem's real state and
  toasts on the offline/online transition, so degradation stays visible.

  NO VERSION LITERAL LIVES IN THIS FILE. The shell is stored under a fixed
  cache key holding whatever the navigation actually returned, so a version
  bump needs no edit here. Adding the filename would be a third place for it to
  drift, on top of APP.version, the header chip and the netlify.toml rewrites.

  Deploy alongside the HTML at the site root. Both must be served with
  max-age=0, must-revalidate; see netlify.toml. The browser manages worker
  update checks. HTML navigation is network-first and refreshes the saved shell
  on a successful response, even when the worker script has not changed.
*/

'use strict';

const CACHE = 'airdesk-shell';
// A cache key, not a real path. Fixed so the entry is replaced rather than
// accumulating one copy per URL the desk was opened at.
const SHELL_KEY = '/__airdesk-shell';
const NETWORK_TIMEOUT_MS = 3000;

self.addEventListener('install', event => {
  // Prefetch so the first offline load works even if the operator has not
  // navigated since the worker installed. Failure here is not fatal: the
  // first successful navigation populates the cache anyway.
  event.waitUntil(
    caches.open(CACHE)
      .then(cache => fetch('/', { cache: 'reload' })
        .then(res => (res && res.ok) ? cache.put(SHELL_KEY, res) : undefined))
      .catch(() => undefined)
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  // Take over open tabs immediately. The worker only ever serves the shell as
  // a fallback, so an immediate handover cannot change what a running desk is
  // showing — and waiting would delay updates reaching the workstation.
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k.startsWith(CACHE + '-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.mode !== 'navigate') return;
  if (new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(shellNetworkFirst(req));
});

/*
  Network first, with a timeout so a hung connection does not leave the
  operator staring at a blank tab. Cache is a fallback only: a reachable
  successful network response wins. Network failures, timeouts and host 5xx
  errors may use the last saved shell; live-service responses are never cached.
*/
async function shellNetworkFirst(req) {
  // Cache storage may be unavailable or full. It must never prevent a live load.
  const cache = await caches.open(CACHE).catch(() => null);
  try {
    const res = await withTimeout(fetch(req), NETWORK_TIMEOUT_MS);
    if (res && res.ok) {
      if (cache) await cache.put(SHELL_KEY, res.clone()).catch(() => undefined);
      return res;
    }
    // A transient host failure should still allow the cached desk to open.
    if (res && res.status >= 500 && cache) {
      const cached = await cache.match(SHELL_KEY).catch(() => null);
      if (cached) return cached;
    }
    return res;
  } catch (err) {
    const cached = cache ? await cache.match(SHELL_KEY).catch(() => null) : null;
    if (cached) return cached;
    throw err;
  }
}

function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('network timeout')), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}
