// Service worker mínimo (PWA instalável). NÃO faz cache de agenda, documentos ou respostas privadas:
// tudo passa pela rede; apenas uma página estática de "sem conexão" é servida quando offline.
const OFFLINE = '/offline.html';
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('offline-v1').then((c) => c.add(OFFLINE)));
  self.skipWaiting();
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== 'offline-v1').map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match(OFFLINE)));
  }
});
