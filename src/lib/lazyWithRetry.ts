import { lazy, type ComponentType } from "react";

// React.lazy mit einmaligem Auto-Reload: Nach einem Deploy referenziert eine noch
// offene (per Cache-Control: immutable ausgelieferte) index.html teils gehashte
// Chunk-Namen, die es nicht mehr gibt → der dynamische Import wirft. Auf
// Kiosk-Laptops, die tagelang offen bleiben, ist genau das der häufigste
// Weißbild-Fall. Hier: beim ersten Fehlschlag die Seite einmal neu laden
// (frische index.html), erst beim zweiten Mal den Fehler an die ErrorBoundary
// durchreichen.
export function lazyWithRetry<T extends ComponentType<any>>(
  factory: () => Promise<{ default: T }>,
  key: string,
) {
  const flag = `rezeptlogik:chunk-retry:${key}`;
  return lazy(async () => {
    try {
      const mod = await factory();
      try { sessionStorage.removeItem(flag); } catch { /* private mode */ }
      return mod;
    } catch (err) {
      let alreadyRetried = false;
      try { alreadyRetried = sessionStorage.getItem(flag) === "1"; } catch { /* private mode */ }
      if (!alreadyRetried) {
        try { sessionStorage.setItem(flag, "1"); } catch { /* private mode */ }
        window.location.reload();
        // Reload läuft — nie erfüllendes Promise, damit kein Fehler aufflackert.
        return new Promise<{ default: T }>(() => { /* pending bis Reload */ });
      }
      throw err;
    }
  });
}
