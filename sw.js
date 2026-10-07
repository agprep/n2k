/* N2K Logistics — service worker
   Job: make the app installable and let the SHELL (the HTML/CSS/JS pages
   themselves, plus icons) show up instantly and even on a poor connection.

   It NEVER caches anything from Supabase (data, auth, storage) or the
   supabase-js library — every one of those always goes straight to the
   network. Bookings, dispatch numbers, and everything else the business
   runs on must always be live; the risk of a stale cached figure is worse
   than a slow load, so this file bumps VERSION whenever the shell needs a
   forced refresh. */
const VERSION = 'n2k-shell-v2';
const SHELL = [
  './',
  './index.html',
  './n2k_dispatch.html',
  './n2k_masters.html',
  './n2k_reports.html',
  './n2k_roadmap.html',
  './n2k_agent_booking.html',
  './n2k_delivery.html',
  './n2k_db.js',
  './manifest.webmanifest',
  './offline.html',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-192-maskable.png',
  './icons/icon-512-maskable.png',
  './icons/apple-touch-icon.png',
  './icons/favicon-32.png',
  './icons/favicon-16.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(VERSION)
      .then(c => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Anything hitting Supabase, or the supabase-js library itself, is left
// completely alone — the service worker does not touch it in any way.
function isLiveOrLibrary(url) {
  return url.hostname.endsWith('supabase.co') || url.hostname.includes('jsdelivr.net');
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;               // never intercept writes

  const url = new URL(req.url);
  if (isLiveOrLibrary(url)) return;                // let the browser handle it natively

  // Page loads AND n2k_db.js: always try the network first. n2k_db.js in
  // particular changes constantly during active development — serving a
  // stale cached copy alongside a freshly-fetched HTML page is exactly how
  // a page ends up calling a function that doesn't exist yet in the old
  // cache and quietly breaking. Only fall back to whatever's cached (this
  // page, or the offline page as a last resort) when the network genuinely
  // isn't there. If the cached page loads, its own built-in "No connection
  // to the database" banner still does its job once Supabase itself fails.
  if (req.mode === 'navigate' || url.pathname.endsWith('/n2k_db.js')) {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(cached => cached || caches.match('./offline.html')))
    );
    return;
  }

  // Everything else in the shell (css/icons — things that barely ever
  // change): serve from cache instantly if we have it, and refresh the
  // cache quietly in the background so the NEXT load already has whatever
  // changed.
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req).then(res => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then(c => c.put(req, copy));
        }
        return res;
      }).catch(() => cached);
      return cached || network;
    })
  );
});
