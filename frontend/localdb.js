const DB_NAME = 'msgpwa_v1';
const STORE = 'chat_history';
let db;

export const LocalDB = {
  init: () => new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore(STORE, { keyPath: 'id' });
    req.onsuccess = e => { db = e.target.result; resolve(); };
    req.onerror = e => reject(e.target.error);
  }),

  save: (msg) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(msg);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }),

  load: (userId) => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = req.result || [];
      // Filtra conversas com o usuário atual (independente de quem enviou)
      const filtered = all.filter(m => m.to === userId || m.from === userId)
                          .sort((a, b) => a.timestamp - b.timestamp);
      resolve(filtered);
    };
    req.onerror = () => reject(req.error);
  }),

  clear: () => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  })
};