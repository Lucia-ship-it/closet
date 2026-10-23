// Everything is stored on this device (IndexedDB) - nothing is sent to the internet.
const DB_NAME = 'satnik';
const ITEMS = 'items';
const OUTFITS = 'outfits';

let dbPromise;
let blockedHandler = () => {};

// Called when storage cannot be updated because another tab or window of the app is still open.
export const onBlocked = (fn) => {
  blockedHandler = fn;
};

function open() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      for (const name of [ITEMS, OUTFITS]) {
        if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => {
      req.result.onversionchange = () => req.result.close();
      resolve(req.result);
    };
    req.onblocked = () => blockedHandler();
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(store, mode, action) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = action(tx.objectStore(store));
    tx.oncomplete = () => resolve(req.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const getAll = () => run(ITEMS, 'readonly', (s) => s.getAll());
export const put = (item) => run(ITEMS, 'readwrite', (s) => s.put(item));
export const remove = (id) => run(ITEMS, 'readwrite', (s) => s.delete(id));

export const getOutfits = () => run(OUTFITS, 'readonly', (s) => s.getAll());
export const putOutfit = (outfit) => run(OUTFITS, 'readwrite', (s) => s.put(outfit));
export const removeOutfit = (id) => run(OUTFITS, 'readwrite', (s) => s.delete(id));

// Asks the browser not to delete the data when storage runs low.
export function askPersist() {
  navigator.storage?.persist?.().catch(() => {});
}
