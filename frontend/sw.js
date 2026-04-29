// sw.js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('push', (event) => {
  console.log('🔔 Push recebido no SW:', event.data ? event.data.json() : 'Sem dados');
  const data = event.data ? event.data.json() : { title: 'Nova mensagem', body: 'Toque para abrir.' };
  
  const options = {
    body: data.body,
    icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png',
    vibrate: [200, 100, 200],
    tag: 'msg-notification',
    renotify: true,
    data: { url: '/' }
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow('/'));
});
