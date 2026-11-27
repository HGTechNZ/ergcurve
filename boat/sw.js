// Boat Recorder offline cache. Network first, so a reload always picks up the newest version when online.
// v1.1: if the network doesn't answer within 3 s (weak wifi at the shed, no SIM on the water) the cached copy is used,
// and older boat-* caches are cleared on activate. Other apps' caches (oarlock-*, ErgCurve) are left alone.
const CACHE = "boat-v2";
const FILES = ["./", "./index.html", "./manifest.json", "./icon-192.png", "./icon-512.png"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES.map(f => new Request(f, { cache: "reload" }))))); self.skipWaiting(); });
self.addEventListener("activate", e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => /^boat-/.test(k) && k !== CACHE).map(k => caches.delete(k)))).catch(() => {}).then(() => self.clients.claim()));
});
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  const net = fetch(e.request, { cache: "no-store" }).then(r => { if (r && r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)).catch(() => {}); } return r; });
  const cached = () => caches.match(e.request, { ignoreSearch: true });
  e.respondWith(new Promise(resolve => {
    let done = false;
    const fallback = () => cached().then(c => { if (done) return; if (c) { done = true; resolve(c); } });
    const timer = setTimeout(fallback, 3000);
    net.then(r => { clearTimeout(timer); if (!done) { done = true; resolve(r); } })
       .catch(() => { clearTimeout(timer); cached().then(c => { if (!done) { done = true; resolve(c || Response.error()); } }); });
  }));
});
