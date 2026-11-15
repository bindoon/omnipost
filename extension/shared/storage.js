let database;
export function db() {
  return (database ||= new Promise((resolve, reject) => {
    const r = indexedDB.open("omnipost", 1);
    r.onupgradeneeded = () => {
      r.result.createObjectStore("assets");
      r.result.createObjectStore("jobs", { keyPath: "id" });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  }));
}
export async function put(store, value, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function remove(store, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, "readwrite");
    tx.objectStore(store).delete(key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}
export async function get(store, key) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).get(key);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function all(store) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const r = d.transaction(store).objectStore(store).getAll();
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
export async function fileChunk(id, index) {
  const file = await get("assets", id);
  if (!file) throw new Error("素材不存在");
  if (!Number.isSafeInteger(index) || index < 0)
    throw new Error("分片序号无效");
  const bytes = new Uint8Array(
    await file.slice(index * 1024 ** 2, (index + 1) * 1024 ** 2).arrayBuffer(),
  );
  let s = "";
  for (let i = 0; i < bytes.length; i += 8192)
    s += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(s);
}
