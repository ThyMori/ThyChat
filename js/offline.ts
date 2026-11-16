// Mode hors-ligne : cache de lecture des requêtes Supabase et file d'attente des messages à envoyer.
//
// - `withReadCache(client, …)` enveloppe le client Supabase : chaque lecture réussie est gardée sur l'appareil ;
//   quand le réseau manque, la dernière réponse connue est rendue à la place. Les écritures passent telles quelles.
// - `createStore()` range tout dans IndexedDB (ou en mémoire si le navigateur ne l'offre pas).

import type { SupabaseClient } from "@supabase/supabase-js";

// Lecture gardée sur l'appareil.
export interface ReadEntry {
  key?: string;
  data: unknown;
  count: number | null;
  at: number;
}

// Message en attente d'envoi (les autres champs dépendent du message).
export interface OutboxEntry {
  id: string;
  user_id: string;
  created_at: string;
  [field: string]: unknown;
}

// Résultat d'une opération sur le magasin : `fallback` quand IndexedDB n'est pas disponible.
interface RunResult {
  fallback?: boolean;
  value?: any;
}

const DB_NAME = "thychat-offline";
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // les lectures de plus de 30 jours sont oubliées
const WRITES = new Set(["insert", "update", "upsert", "delete"]);

// Une erreur « réseau » (pas une erreur de la base) : pas de connexion, serveur injoignable, délai dépassé.
export function isNetworkError(error: { code?: string; message?: string } | null | undefined, status?: number): boolean {
  if (!error) return false;
  if (error.code) return false; // les erreurs de la base (droits, contraintes…) ont un code
  return status === 0 || /fetch|network|load failed|timeout|timed out|abort|connexion/i.test(String(error.message || error));
}

const hash = (text: string): string => {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36) + "-" + text.length;
};

export function createStore() {
  const mem = { reads: new Map<string, ReadEntry>(), outbox: new Map<string, OutboxEntry>() };
  let opening: Promise<IDBDatabase | null> | null = null;

  const open = () => {
    if (opening) return opening;
    opening = new Promise<IDBDatabase | null>((resolve) => {
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
  const run = async (name: string, mode: IDBTransactionMode, make: (store: IDBObjectStore) => IDBRequest | undefined | null): Promise<RunResult> => {
    const db = await open();
    if (!db) return { fallback: true };
    return new Promise<RunResult>((resolve) => {
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
    async getRead(key: string): Promise<ReadEntry | undefined> {
      const out = await run("reads", "readonly", (s) => s.get(key));
      return out.fallback ? mem.reads.get(key) : out.value;
    },
    async setRead(key: string, entry: ReadEntry): Promise<void> {
      const out = await run("reads", "readwrite", (s) => s.put({ key, ...entry }));
      if (out.fallback) mem.reads.set(key, { key, ...entry });
    },
    async prune(prefix: string): Promise<void> {
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
    async outboxAll(userId: string): Promise<OutboxEntry[]> {
      const out = await run("outbox", "readonly", (s) => s.getAll());
      const all: OutboxEntry[] = out.fallback ? [...mem.outbox.values()] : out.value || [];
      return all.filter((entry) => entry.user_id === userId).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
    },
    async outboxPut(entry: OutboxEntry): Promise<void> {
      const out = await run("outbox", "readwrite", (s) => s.put(entry));
      if (out.fallback) mem.outbox.set(entry.id, entry);
    },
    async outboxDelete(id: string): Promise<void> {
      const out = await run("outbox", "readwrite", (s) => s.delete(id));
      if (out.fallback) mem.outbox.delete(id);
    },
    // Déconnexion : on efface tout ce qui appartient à cette personne.
    async wipe(userId: string): Promise<void> {
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
export type OfflineStore = ReturnType<typeof createStore>;

interface ReadCacheOptions {
  userId: string;
  store: OfflineStore;
  isOnline?: () => boolean;
  onServed?: () => void;
  onLive?: () => void;
  timeoutMs?: number;
}

export function withReadCache<C extends SupabaseClient<any, any, any>>(client: C, { userId, store, isOnline = () => typeof navigator === "undefined" || navigator.onLine !== false, onServed = () => {}, onLive = () => {}, timeoutMs = 8000 }: ReadCacheOptions): C {
  // Le constructeur de requêtes de Supabase est enveloppé dynamiquement : ses types précis n'apportent rien ici.
  const wrap = (real: any, table: string) => {
    const calls: [string, unknown[]][] = [];
    let current: any = real;
    let write = false;

    const run = async (): Promise<any> => {
      if (write || calls.some(([name]) => name === "ilike")) return current; // pas de cache pour les écritures ni la recherche
      const key = `${userId}|${hash(table + JSON.stringify(calls))}`;
      const cachedPromise = store.getRead(key).catch((): undefined => undefined);
      const serve = (cached: ReadEntry) => {
        onServed();
        return { data: cached.data, count: cached.count ?? null, error: null as any, status: 200, statusText: "OK (appareil)" };
      };
      if (!isOnline()) {
        const cached = await cachedPromise;
        if (cached) return serve(cached);
      }
      const network = Promise.resolve(current).then(
        (result: any) => {
          if (result && !result.error) {
            store.setRead(key, { data: result.data, count: result.count ?? null, at: Date.now() }).catch(() => {});
            onLive(); // y compris une réponse tardive, arrivée après qu'on a affiché la copie de l'appareil
          }
          return result;
        },
        (error: any) => ({ data: null as any, error: { message: String((error && error.message) || error) }, status: 0 })
      );
      const cached = await cachedPromise;
      let result: any;
      if (cached) {
        // Réseau lent : on affiche ce qu'on a plutôt que d'attendre.
        let timer: ReturnType<typeof setTimeout> | undefined;
        const slow = new Promise<null>((resolve) => {
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

    const proxy: any = new Proxy(
      {},
      {
        get(_, prop: string) {
          if (prop === "then") return (resolve: any, reject: any) => run().then(resolve, reject);
          if (prop === "catch") return (reject: any) => run().catch(reject);
          if (prop === "finally") return (done: any) => run().finally(done);
          return (...args: unknown[]) => {
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
      if (prop === "from") return (table: string) => wrap(target.from(table), table);
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
