"use strict";
/**
 * cassidyCompat.js — couche de compatibilité base de données
 * Ajoute à threadsData / usersData / globalData (style GoatBot : get/set/create...)
 * les méthodes style Cassidy utilisées par ~20 commandes :
 * getCache, getItem, setItem, queryItem, queryItemAll, deleteItem, getAllCache,
 * cache, exists, ensureThreadInfo, ensureUserInfo, getUserInfo, isNumKey, isMongo...
 * Ne remplace jamais une méthode déjà existante.
 */
function addIfMissing(target, name, fn) {
  if (typeof target[name] !== "function") target[name] = fn;
}

function wrap(store, kind) {
  if (!store || store.__cassidyCompat) return store;
  const idKey = kind === "users" ? "userID" : kind === "threads" ? "threadID" : "key";
  const getRaw = async (id) => {
    try {
      return (await store.get(isNaN(id) || kind === "global" ? id : Number(id))) || {};
    } catch {
      return {};
    }
  };
  const setRaw = async (id, data) => store.set(kind === "global" ? id : Number(id), data);
  const pick = (obj, props) => {
    const out = {};
    for (const p of props.flat()) if (p in obj) out[p] = obj[p];
    return out;
  };

  addIfMissing(store, "getCache", getRaw);
  addIfMissing(store, "getItem", getRaw);
  addIfMissing(store, "get_", getRaw);
  addIfMissing(store, "setItem", async (id, data) => setRaw(id, data ?? {}));
  addIfMissing(store, "queryItem", async (id, ...props) => {
    const data = await getRaw(id);
    return props.length ? pick(data, props) : data;
  });
  addIfMissing(store, "queryItemAll", async (ids, ...props) => {
    const out = {};
    for (const id of [].concat(ids)) out[id] = await store.queryItem(id, ...props);
    return out;
  });
  addIfMissing(store, "getItems", async (...ids) => {
    const out = {};
    for (const id of ids.flat()) out[id] = await getRaw(id);
    return out;
  });
  addIfMissing(store, "deleteItem", async (id) => store.remove(id));
  addIfMissing(store, "getAllCache", async () => {
    try {
      const all = store.getAll ? await store.getAll() : [];
      if (Array.isArray(all)) {
        return Object.fromEntries(all.map((x) => [x[idKey] ?? x.key, x]));
      }
      return all || {};
    } catch {
      return {};
    }
  });
  addIfMissing(store, "cache", {});
  addIfMissing(store, "getIDs", async () => Object.keys(await store.getAllCache()));
  addIfMissing(store, "exists", async (id) =>
    store.existsSync ? store.existsSync(id) : Object.keys(await getRaw(id)).length > 0
  );
  addIfMissing(store, "isNumKey", (k) => typeof k === "number" || /^\d+$/.test(String(k)));
  addIfMissing(store, "isMongo", () => false);

  if (kind === "threads") {
    addIfMissing(store, "ensureThreadInfo", async (id, api) => {
      const d = await getRaw(id);
      if (Object.keys(d).length === 0 && store.create) await store.create(Number(id));
      return getRaw(id);
    });
    addIfMissing(store, "saveThreadInfo", async (id, info) => setRaw(id, { threadInfo: info }));
  }
  if (kind === "users") {
    addIfMissing(store, "ensureUserInfo", async (id) => {
      const d = await getRaw(id);
      if (Object.keys(d).length === 0 && store.create) await store.create(Number(id));
      return getRaw(id);
    });
    addIfMissing(store, "getUserInfo", async (id) => {
      const d = await getRaw(id);
      return { name: d.name || "Unknown", ...d };
    });
    addIfMissing(store, "saveUserInfo", async (id, info) => setRaw(id, info));
    addIfMissing(store, "getAvatarURL", async (id) =>
      store.getAvatarUrl ? store.getAvatarUrl(id) : ""
    );
  }

  Object.defineProperty(store, "__cassidyCompat", { value: true });
  return store;
}

module.exports = function applyCassidyCompat(db) {
  if (!db) return db;
  wrap(db.threadsData, "threads");
  wrap(db.usersData, "users");
  wrap(db.globalData, "global");
  return db;
};
module.exports.wrap = wrap;
