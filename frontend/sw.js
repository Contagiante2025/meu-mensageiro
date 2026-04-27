// sw.js
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : { title: 'Nova mensagem', body: 'Toque para ler.' };
  
  const options = {
    body: data.body,
    icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png',
    vibrate: [200, 100, 200],
    tag: 'msg-notification',
    renotify: true
  };

  event.waitUntil(self.registration.showNotification(data.title, options));
  
  // Log para debug (aparece no console do Service Worker)
  console.log('🔔 Push recebido:', data);
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      if (clients.length > 0) return clients[0].focus();
      return self.clients.openWindow('/');
    })
  );
});
