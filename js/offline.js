// Mode hors-ligne : cache de lecture des requêtes Supabase et file d'attente des messages à envoyer.
//
// - `withReadCache(client, …)` enveloppe le client Supabase : chaque lecture réussie est gardée sur l'appareil ;
//   quand le réseau manque, la dernière réponse connue est rendue à la place. Les écritures passent telles quelles.
// - `createStore()` range tout dans IndexedDB (ou en mémoire si le navigateur ne l'offre pas).

const DB_NAME = "thychat-offline";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // les lectures de plus de 30 jours sont oubliées
const WRITES = new Set(["insert", "update", "upsert", "delete"]);

// Une erreur « réseau » (pas une erreur de la base) : pas de connexion, serveur injoignable, délai dépassé.
export function isNetworkError(error, status) {
  if (!error) return false;
  if (error.code) return false; // les erreurs de la base (droits, contraintes…) ont un code
  return status === 0 || /fetch|network|load failed|timeout|timed out|abort|connexion/i.test(String(error.message || error));
}

const hash = (text) => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36) + "-" + text.length;
};

export function createStore() {
  const mem = { reads: new Map(), outbox: new Map() };
  let opening = null;

  const open = () => {
    if (opening) return opening;
    opening = new Promise((resolve) => {
      if (typeof indexedDB === "undefined") return resolve(null);
      try {
        const request = indexedDB.open(DB_NAME, 1);
        request.onupgradeneeded = () => {
          const db = request.result;
          db.createObjectStore("reads", { keyPath: "key" });
          db.createObjectStore("outbox", { keyPath: "id" });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => resolve(null);
        request.onblocked = () => resolve(null);
      } catch {
        resolve(null);
      }
    });
    return opening;
  };

  // Exécute une opération sur un magasin IndexedDB ; en cas d'échec, rend `undefined` (tout est facultatif).
  const run = async (name, mode, make) => {
    const db = await open();
    if (!db) return { fallback: true };
    return new Promise((resolve) => {
      try {
        const tx = db.transaction(name, mode);
        const request = make(tx.objectStore(name));
        tx.oncomplete = () => resolve({ value: request ? request.result : undefined });
        tx.onerror = tx.onabort = () => resolve({ value: undefined });
      } catch {
        resolve({ value: undefined });
      }
    });
  };

  return {
    async getRead(key) {
      const out = await run("reads", "readonly", (s) => s.get(key));
      return out.fallback ? mem.reads.get(key) : out.value;
    },
    async setRead(key, entry) {
      const out = await run("reads", "readwrite", (s) => s.put({ key, ...entry }));
      if (out.fallback) mem.reads.set(key, { key, ...entry });
    },
    async prune(prefix) {
      const limit = Date.now() - MAX_AGE_MS;
      const out = await run("reads", "readwrite", (s) => {
        const cursor = s.openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          if (String(at.value.key).startsWith(prefix) && (at.value.at || 0) < limit) at.delete();
          at.continue();
        };
        return cursor;
      });
      if (out.fallback) for (const [key, value] of mem.reads) if (key.startsWith(prefix) && (value.at || 0) < limit) mem.reads.delete(key);
    },
    async outboxAll(userId) {
      const out = await run("outbox", "readonly", (s) => s.getAll());
      const all = out.fallback ? [...mem.outbox.values()] : out.value || [];
      return all.filter((entry) => entry.user_id === userId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
    async outboxPut(entry) {
      const out = await run("outbox", "readwrite", (s) => s.put(entry));
      if (out.fallback) mem.outbox.set(entry.id, entry);
    },
    async outboxDelete(id) {
      const out = await run("outbox", "readwrite", (s) => s.delete(id));
      if (out.fallback) mem.outbox.delete(id);
    },
    // Déconnexion : on efface tout ce qui appartient à cette personne.
    async wipe(userId) {
      const prefix = userId + "|";
      const reads = await run("reads", "readwrite", (s) => {
        const cursor = s.openCursor();
        cursor.onsuccess = () => {
          const at = cursor.result;
          if (!at) return;
          if (String(at.value.key).startsWith(prefix)) at.delete();
          at.continue();
        };
        return cursor;
      });
      if (reads.fallback) for (const key of [...mem.reads.keys()]) if (key.startsWith(prefix)) mem.reads.delete(key);
      for (const entry of await this.outboxAll(userId)) await this.outboxDelete(entry.id);
    },
  };
}

// Client Supabase « avec mémoire » : `from(table)…` garde la dernière réponse de chaque lecture.
export function withReadCache(client, { userId, store, isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false, onServed = () => {}, onLive = () => {}, timeoutMs = 8000 }) {
  const wrap = (real, table) => {
    const calls = [];
    let current = real;
    let write = false;

    const run = async () => {
      if (write || calls.some(([name]) => name === "ilike")) return current; // pas de cache pour les écritures ni la recherche
      const key = `${userId}|${hash(table + JSON.stringify(calls))}`;
      const cachedPromise = store.getRead(key).catch(() => undefined);
      const serve = (cached) => {
        onServed();
        return { data: cached.data, count: cached.count ?? null, error: null, status: 200, statusText: "OK (appareil)" };
      };
      if (!isOnline()) {
        const cached = await cachedPromise;
        if (cached) return serve(cached);
      }
      const network = Promise.resolve(current).then(
        (result) => {
          if (result && !result.error) {
            store.setRead(key, { data: result.data, count: result.count ?? null, at: Date.now() }).catch(() => {});
            onLive(); // y compris une réponse tardive, arrivée après qu'on a affiché la copie de l'appareil
          }
          return result;
        },
        (error) => ({ data: null, error: { message: String((error && error.message) || error) }, status: 0 })
      );
      const cached = await cachedPromise;
      let result;
      if (cached) {
        // Réseau lent : on affiche ce qu'on a plutôt que d'attendre.
        let timer;
        const slow = new Promise((resolve) => {
          timer = setTimeout(() => resolve(null), timeoutMs);
        });
        result = await Promise.race([network, slow]);
        clearTimeout(timer);
      } else {
        result = await network;
      }
      if (result && !result.error) return result;
      if (cached && (!result || isNetworkError(result.error, result.status))) return serve(cached);
      return result;
    };

    const proxy = new Proxy(
      {},
      {
        get(_, prop) {
          if (prop === "then") return (resolve, reject) => run().then(resolve, reject);
          if (prop === "catch") return (reject) => run().catch(reject);
          if (prop === "finally") return (done) => run().finally(done);
          return (...args) => {
            if (WRITES.has(prop)) write = true;
            calls.push([prop, args]);
            current = current[prop](...args);
            return proxy;
          };
        },
      }
    );
    return proxy;
  };

  return new Proxy(client, {
    get(target, prop) {
      if (prop === "from") return (table) => wrap(target.from(table), table);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
