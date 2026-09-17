/**
 * Regions the user uploaded, kept across visits.
 *
 * Deliberately a separate database from the zarr cache in db.js, for two
 * reasons. "Clear cached data" deletes that whole database, and an uploaded
 * boundary is the user's own work rather than something re-downloadable.
 * pruneStaleCache() also deletes anything not carrying the current
 * DATA_VERSION, which would take these with it on the next data rebuild.
 *
 * Rings are stored as plain arrays rather than a serialized ArcGIS geometry, so
 * a record stays readable across SDK versions.
 */

const DB_NAME = "ggg-user-regions";
const DB_VERSION = 1;
const STORE_NAME = "regions";

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, {keyPath: "id"});
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

const tx = (mode, run) =>
  openDB().then(
    (db) =>
      new Promise((resolve, reject) => {
        const t = db.transaction(STORE_NAME, mode);
        const req = run(t.objectStore(STORE_NAME));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
        t.oncomplete = () => db.close();
      }),
  );

/** @returns {Promise<Array<{id: string, name: string, rings: number[][][], addedAt: number}>>} */
export const listUserRegions = () => tx("readonly", (store) => store.getAll());

export const putUserRegion = (record) => tx("readwrite", (store) => store.put(record));

export const deleteUserRegion = (id) => tx("readwrite", (store) => store.delete(id));

// Prefixed so it can never collide with a numeric id from regions.geojson, which
// the region list keys off.
export const newUserRegionId = () => `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
