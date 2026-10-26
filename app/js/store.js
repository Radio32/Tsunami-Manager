// IndexedDB persistence: the project JSON plus the original source audio bytes.

const DB_NAME = 'nutella-tsunami-manager';
let dbp;

function db() {
  dbp ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      d.createObjectStore('kv');
      d.createObjectStore('sources', { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const s = t.objectStore(store);
    const r = fn(s);
    t.oncomplete = () => resolve(r?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const saveProject = p => tx('kv', 'readwrite', s => s.put(p, 'project'));
export const loadProject = () => tx('kv', 'readonly', s => s.get('project'));
export const putSource = rec => tx('sources', 'readwrite', s => s.put(rec));
export const getSource = id => tx('sources', 'readonly', s => s.get(id));
export const deleteSource = id => tx('sources', 'readwrite', s => s.delete(id));
export const listSourceKeys = () => tx('sources', 'readonly', s => s.getAllKeys());
export const clearSources = () => tx('sources', 'readwrite', s => s.clear());

export async function storageEstimate() {
  try { return await navigator.storage.estimate(); } catch { return null; }
}

export async function requestPersistence() {
  try { return await navigator.storage.persist(); } catch { return false; }
}
