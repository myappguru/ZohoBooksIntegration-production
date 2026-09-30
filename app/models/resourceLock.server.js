import mysql from "mysql2/promise";

// Serializes "look up mapping -> create in Zoho -> save mapping" per Shopify
// resource. Shopify fires orders/create, orders/paid and orders/updated (or
// products/create + products/update, customers/create + customers/update)
// within about a second of each other; without this, each handler sees no
// mapping yet and creates its own Zoho record, leaving duplicates in Zoho.
//
// Two layers:
// 1. An in-process keyed mutex - this is what actually serializes requests
//    on a single Node process (how the app is deployed today).
// 2. A MySQL GET_LOCK on a small dedicated pool, so the guarantee still
//    holds if the app is ever run as several processes/instances. It is
//    best effort: if no lock connection can be had within a few seconds we
//    log and carry on under the in-process lock alone, rather than let a
//    starved pool stall webhooks forever.
//
// Callers MUST re-read the mapping from the DB inside `fn` - a snapshot
// taken before the lock was acquired is exactly the stale view that
// caused the duplicates.

const LOCK_WAIT_SECONDS = 30;
const LOCK_CONNECTION_TIMEOUT_MS = 5000;

const localLocks = new Map();

let lockPool = null;
function getLockPool() {
  if (!lockPool) {
    lockPool = mysql.createPool({
      host: process.env.DB_HOST || "127.0.0.1",
      port: Number(process.env.DB_PORT || 3307),
      user: process.env.DB_USERNAME || "root",
      password: process.env.DB_PASSWORD || "",
      database: process.env.DB_DATABASE || "dev-zohobooksintegration",
      waitForConnections: true,
      connectionLimit: 20,
      queueLimit: 0,
    });
  }
  return lockPool;
}

async function withLocalLock(key, fn) {
  const previous = localLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.then(() => current);
  localLocks.set(key, tail);

  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (localLocks.get(key) === tail) localLocks.delete(key);
  }
}

async function acquireDbLock(key) {
  // MySQL lock names are capped at 64 characters.
  const name = key.length > 64 ? `zb:${hash(key)}` : key;
  let connection = null;

  const connectionPromise = getLockPool().getConnection();
  try {
    connection = await Promise.race([
      connectionPromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("lock connection timeout")), LOCK_CONNECTION_TIMEOUT_MS),
      ),
    ]);
  } catch (error) {
    // Don't leak the connection if it arrives after we gave up on it.
    connectionPromise.then((late) => late.release()).catch(() => {});
    console.warn("resourceLock: continuing without DB lock", key, error.message);
    return null;
  }

  try {
    const [rows] = await connection.query("SELECT GET_LOCK(?, ?) AS acquired", [name, LOCK_WAIT_SECONDS]);
    if (rows[0]?.acquired !== 1) {
      connection.release();
      throw new Error(`Timed out waiting for lock ${key}`);
    }
    return { connection, name };
  } catch (error) {
    if (error.message?.startsWith("Timed out waiting for lock")) throw error;
    connection.release();
    console.warn("resourceLock: GET_LOCK failed, continuing without DB lock", key, error.message);
    return null;
  }
}

async function releaseDbLock(lock) {
  if (!lock) return;
  try {
    await lock.connection.query("SELECT RELEASE_LOCK(?)", [lock.name]);
  } catch (error) {
    console.warn("resourceLock: RELEASE_LOCK failed", lock.name, error.message);
  } finally {
    lock.connection.release();
  }
}

function hash(value) {
  let h = 0;
  for (let i = 0; i < value.length; i += 1) h = (Math.imul(31, h) + value.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

export function resourceLockKey(shopId, entityType, shopifyId) {
  return `zb:${shopId}:${entityType}:${shopifyId}`;
}

export async function withResourceLock(key, fn) {
  return withLocalLock(key, async () => {
    const dbLock = await acquireDbLock(key);
    try {
      return await fn();
    } finally {
      await releaseDbLock(dbLock);
    }
  });
}
