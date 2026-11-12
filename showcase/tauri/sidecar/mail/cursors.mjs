// Where reading stopped, per account and folder: the folder's UIDVALIDITY and the last UID looked at, in
// <data dir>/mail.db (private, like money.db). A different UIDVALIDITY means the server renumbered the folder, so
// the cursor no longer applies and the next read starts over with the date window.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openCursors(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.closeSync(fs.openSync(file, 'a', 0o600));
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = 3000;
    CREATE TABLE IF NOT EXISTS folders (
      account TEXT NOT NULL, folder TEXT NOT NULL, uid_validity TEXT NOT NULL, last_uid INTEGER NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY (account, folder));`);
  return {
    file,
    /** → { uidValidity, lastUid } or null. */
    get(account, folder) {
      const r = db.prepare('SELECT uid_validity, last_uid FROM folders WHERE account = ? AND folder = ?').get(account, folder);
      return r ? { uidValidity: r.uid_validity, lastUid: Number(r.last_uid) } : null;
    },
    set(account, folder, uidValidity, lastUid) {
      db.prepare(`INSERT INTO folders (account, folder, uid_validity, last_uid, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT (account, folder) DO UPDATE SET uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, updated_at = excluded.updated_at`)
        .run(account, folder, String(uidValidity), lastUid, new Date().toISOString());
    },
    /** Drops an account's cursors (it was removed). */
    forget: (account) => db.prepare('DELETE FROM folders WHERE account = ?').run(account),
    close: () => db.close(),
  };
}
