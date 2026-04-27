// sw.js

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', () => self.clients.claim());

self.addEventListener('push', function (event) {
  // Dados recebidos do backend
  const data = event.data ? event.data.json() : { title: 'Nova mensagem', body: 'Você recebeu uma mensagem.' };

  const options = {
    body: data.body,
    icon: data.icon || 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png',
    badge: 'https://cdn-icons-png.flaticon.com/512/2906/2906313.png',
    vibrate: [200, 100, 200],
    data: { dateOfArrival: Date.now(), primaryKey: 1 }
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Opcional: Clicar na notificação abre o app
self.addEventListener('notificationclick', function(event) {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window' }).then( clientList => {
      if (clientList.length > 0) {
        return clientList[0].focus();
      }
      return self.clients.openWindow('/');
    })
  );
});
