// Service worker: recibe las alertas push y las muestra aunque la app esté cerrada
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (e) => {
  let d = { title: "Mi Bus", body: "" };
  try { d = e.data.json(); } catch {}
  e.waitUntil(self.registration.showNotification(d.title, {
    body: d.body, tag: d.tag, icon: "/icons/icon-192.png", badge: "/icons/icon-192.png",
    renotify: true, requireInteraction: true,
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window" }).then((cs) =>
    cs.length ? cs[0].focus() : self.clients.openWindow("/")));
});
