// Service worker para avisos push en la versión web.
import { initializeApp } from 'firebase/app';
import { getMessaging, onBackgroundMessage } from 'firebase/messaging/sw';
import { firebaseConfig } from './firebase-config.js';

const messaging = getMessaging(initializeApp(firebaseConfig));
onBackgroundMessage(messaging, payload => {
  const d = payload.data || {};
  self.registration.showNotification(d.title || 'Hora de tu medicamento', {
    body: d.body || '', tag: d.tag || 'pastillero', renotify: true, requireInteraction: true,
    icon: 'icon-192.png', badge: 'icon-192.png', data: { url: self.registration.scope }
  });
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then(ws => {
    for (const w of ws) if ('focus' in w) return w.focus();
    return clients.openWindow(e.notification.data && e.notification.data.url || './');
  }));
});
