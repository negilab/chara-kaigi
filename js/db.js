// つなぎ役を選ぶ。firebase-config.js に databaseURL が入っていれば Firebase、空なら試験モード。
import { firebaseConfig } from '../firebase-config.js';

let dbPromise = null;
export function isLocalMode() {
  return !(firebaseConfig && firebaseConfig.databaseURL);
}
export function getDb() {
  if (!dbPromise) {
    dbPromise = isLocalMode()
      ? import('./db-local.js').then((m) => m.createLocalDb())
      : import('./db-firebase.js').then((m) => m.createFirebaseDb(firebaseConfig));
  }
  return dbPromise;
}
