// @ts-check
// Optional sync of the settings through the browser's own account sync. The newest revision wins, local data on a tie.
// Pushes and pulls run one after the other. Remote data is fetched here and committed through the state's writer.
// A push that is waiting (the short delay, or the backoff after a failure) is also written to the local storage, so a worker that was
// stopped does not lose it: the next worker, started by any event, picks it up (recover).
import { fetchRemote, syncPush } from '../../shared/store.js';

const DELAY_MS = 2000;
// A push that failed for a reason that can pass (offline, the write rate of the account) is tried again after
// DELAY_MS * 2^k, at most MAX_DELAY_MS, with jitter. After MAX_RETRIES the automatic tries stop; the next change starts one again.
const MAX_DELAY_MS = 5 * 60 * 1000;
const MAX_RETRIES = 8;
const JITTER = 0.25;
// The revision of the last state taken from the account, kept in the local storage so that a worker that was stopped does not push it back.
const PULLED_KEY = 'syncPulled';
// The push that waits: { revision, failures, next } with the revision of the state when it was planned, the failed pushes so far and the
// time of the next try. It exists while a timer waits or a push runs, and only while Sync is on.
export const PENDING_KEY = 'syncPending';

/**
 * @param {{
 *   local?: import('../../shared/store.js').Area,
 *   sync: import('../../shared/store.js').Area,
 *   state: Pick<ReturnType<typeof import('./state.js').createState>, 'read' | 'applyRemote'>,
 *   now?: () => number,
 *   random?: () => number,
 *   setTimer?: (fn: () => void | Promise<void>, ms: number) => any,
 *   clearTimer?: (t: any) => void,
 *   retryAlarm?: { set(when: number): Promise<unknown> | unknown, clear(): Promise<unknown> | unknown },
 * }} deps  `retryAlarm` is the browser's alarm for the waiting push (only with the optional `alarms` permission); it wakes a stopped worker
 */
export function createSync({ local, sync, state, now = () => Date.now(), random = Math.random, setTimer = (fn, ms) => setTimeout(fn, ms), clearTimer = (t) => clearTimeout(t), retryAlarm }) {
  /** @type {any} */
  let timer = null;
  /** The revision of the state last taken from the account; null until it is read from the storage. @type {number | null} */
  let lastPulled = null;
  // Failed pushes in a row.
  let failures = 0;
  let chain = Promise.resolve();
  /** Counts the times Sync was turned off here. A push that began before may not write to the account. */
  let epoch = 0;
  /** Is a record of the waiting push in the storage (as far as this worker knows), and with how many failures? Null: none. @type {number | null} */
  let recorded = null;
  let noting = false;
  /** When the waiting push is due. */
  let nextAt = 0;
  let journal = Promise.resolve();

  /** Run `job` after every push and pull asked for before it. A failing job does not stop the ones behind it. @template T @param {() => Promise<T>} job @returns {Promise<T>} */
  function serial(job) {
    const run = chain.then(job);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function pulled() {
    if (lastPulled !== null) return lastPulled;
    lastPulled = -1;
    try {
      const stored = (await local?.get(PULLED_KEY))?.[PULLED_KEY];
      if (Number.isFinite(stored)) lastPulled = stored;
    } catch {
      // Unreadable: treated as nothing pulled, which costs at most one extra push.
    }
    return lastPulled;
  }

  /** @param {number} revision */
  async function remember(revision) {
    lastPulled = revision;
    try {
      await local?.set({ [PULLED_KEY]: revision });
    } catch {
      // Kept in memory only; a stopped worker may push this state back once.
    }
  }

  /** The wait before the next push: the short delay, or the backoff while pushes fail. */
  function delay() {
    if (failures === 0) return DELAY_MS;
    const base = Math.min(MAX_DELAY_MS, DELAY_MS * 2 ** Math.min(failures, 16));
    return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
  }

  /** Writes to the record, one after the other. @param {() => Promise<void>} job */
  function inJournal(job) {
    journal = journal.then(job).catch(() => {});
    return journal;
  }

  /** Is the waiting push worth keeping across a stop of the worker? @returns {Promise<{ revision: number } | null>} */
  async function wantsRecord() {
    const read = await state.read();
    return read.ok && read.state.settings.syncEnabled ? { revision: read.state.updatedAt } : null;
  }

  /**
   * Keep the waiting push in the storage and in the alarm. A burst of changes writes once: the record only needs to say that something is
   * unsent, and a time that is a little early costs nothing. After a failure the count and the time are written again.
   */
  function note() {
    if (!local || (recorded === failures && failures === 0) || noting) return;
    noting = true;
    void inJournal(async () => {
      noting = false;
      if (timer === null) return;
      const want = await wantsRecord();
      if (!want) return;
      try {
        await local.set({ [PENDING_KEY]: { revision: want.revision, failures, next: nextAt } });
        recorded = failures;
      } catch {
        // Not kept: a stopped worker loses this wait, and the next pull finds the unsent revision.
        return;
      }
      await Promise.resolve(retryAlarm?.set(nextAt)).catch(() => {});
    });
  }

  /** Remove the record when nothing waits any more. @param {boolean} [force] also while a timer waits (Sync was turned off) */
  function settle(force = false) {
    if (recorded === null && !noting && !force) return;
    if (timer !== null && !force) return;
    recorded = null;
    void inJournal(async () => {
      if (timer !== null && !force) return;
      try {
        await local?.remove(PENDING_KEY);
      } catch {
        // Gone with the next write.
      }
      await Promise.resolve(retryAlarm?.clear()).catch(() => {});
    });
  }

  /** @param {number} ms @param {boolean} [keep]  false: the wait comes from the record, which stays as it is */
  function arm(ms, keep = true) {
    if (timer !== null) clearTimer(timer);
    // The callback returns the push, so a test can wait for it; a timer ignores the value.
    timer = setTimer(() => {
      timer = null;
      return push().then(() => undefined);
    }, ms);
    nextAt = now() + ms;
    if (keep) note();
  }

  /** A push that failed for a reason that can pass: count it and wait longer. */
  function retryLater() {
    failures++;
    if (failures <= MAX_RETRIES) arm(delay());
  }

  /** @param {{ payload: Record<string, any>, updatedAt: number }} remote @param {boolean} adopt */
  async function commit(remote, adopt) {
    const r = await state.applyRemote(remote, { adopt });
    if (r.ok && 'applied' in r && r.applied) await remember(/** @type {number} */ (r.updatedAt));
    return r;
  }

  /** @param {any} current */
  async function send(current) {
    let result;
    try {
      result = await syncPush(sync, current);
    } catch {
      result = { ok: false, code: 'quota', retry: true };
    }
    if (result.ok) failures = 0;
    else if ('retry' in result && result.retry) retryLater();
    return result;
  }

  /** A local state is pushed only when the account does not hold a newer one; otherwise the account's data is taken first. */
  const push = () =>
    serial(async () => {
      const mine = epoch;
      let result;
      try {
        result = await pushNow(mine);
      } catch {
        // The account could not be read (offline, the browser's sync is busy): the data is still here, so try again later.
        retryLater();
        result = { ok: false, code: 'error' };
      }
      settle();
      return result;
    });

  /** @param {number} mine the epoch at the start: Sync turned off since then ends the push before it writes */
  async function pushNow(mine) {
    const read = await state.read();
    if (!read.ok || !read.state.settings.syncEnabled) return { ok: false, code: 'disabled' };
    const remote = await fetchRemote(sync, now());
    if (remote.ok && remote.updatedAt > read.state.updatedAt) {
      const r = await commit(remote, false);
      return r.ok ? { ok: true, skipped: true } : r;
    }
    if (!remote.ok && remote.code === 'newer') return remote;
    // A state that was just pulled is not pushed back.
    if (read.state.updatedAt === (await pulled())) return { ok: true, skipped: true };
    if (mine !== epoch) return { ok: false, code: 'disabled' };
    return await send(read.state);
  }

  const pull = () =>
    serial(async () => {
      try {
        const read = await state.read();
        if (!read.ok) return read;
        if (!read.state.settings.syncEnabled) return { ok: false, code: 'disabled' };
        const remote = await fetchRemote(sync, now());
        // A change that this device made but never sent (the worker stopped, or the push failed) goes out now. An account with no
        // snapshot is a valid place to send it to; a snapshot that cannot be read ('newer', 'broken') or a failed read (the catch
        // below) is not: nothing is written over data that was not understood.
        const unsent = read.state.updatedAt !== (await pulled()) && timer === null;
        if (!remote.ok) {
          if (remote.code === 'none' && unsent) arm(DELAY_MS);
          return remote;
        }
        if (remote.updatedAt < read.state.updatedAt && unsent) arm(DELAY_MS);
        return await commit(remote, false);
      } catch {
        return { ok: false, code: 'error' };
      }
    });

  /** Sync was just turned on here: data in the account is taken as it is; an empty account receives this device's data. */
  const join = () =>
    serial(async () => {
      const mine = epoch;
      try {
        const read = await state.read();
        if (!read.ok || !read.state.settings.syncEnabled) return { ok: false, code: 'disabled' };
        const remote = await fetchRemote(sync, now());
        if (remote.ok) return await commit(remote, true);
        if (remote.code === 'newer') return remote;
        if (mine !== epoch) return { ok: false, code: 'disabled' };
        return await send(read.state);
      } catch {
        return { ok: false, code: 'error' };
      }
    });

  /**
   * Start of a worker: pick up a push that an earlier worker left waiting. It is planned again for the time written in the record (at once
   * when that time has passed), with the failure count of the record. A record of a Sync that is off, or of a revision that is already in
   * step with the account, is removed. Safe to call again and again: a push that waits in this worker is left alone.
   */
  const recover = () =>
    serial(async () => {
      try {
        if (!local || timer !== null) return { ok: true, code: 'waiting' };
        const record = (await local.get(PENDING_KEY))?.[PENDING_KEY];
        if (record === undefined) return { ok: true, code: 'none' };
        const read = await state.read();
        if (!read.ok) return { ok: false, code: 'error' };
        const valid = record && typeof record === 'object' && Number.isFinite(record.next) && Number.isInteger(record.failures) && record.failures >= 0;
        if (!valid || !read.state.settings.syncEnabled || read.state.updatedAt === (await pulled())) {
          settle(true);
          return { ok: true, code: 'cleared' };
        }
        failures = Math.min(record.failures, MAX_RETRIES);
        recorded = record.failures;
        // A clock that moved back must not hold the push for a long time.
        arm(Math.max(0, Math.min(record.next - now(), MAX_DELAY_MS * (1 + JITTER))), false);
        return { ok: true, code: 'planned' };
      } catch {
        return { ok: false, code: 'error' };
      }
    });

  return {
    push,
    pull,
    join,
    recover,
    /** Push a little later, so a burst of changes is one push. After failed pushes the wait is the backoff. */
    schedulePush() {
      arm(delay());
    },
    /** Sync was turned off here: the waiting push is dropped, and a push that is running does not write to the account. */
    cancel() {
      epoch++;
      if (timer !== null) clearTimer(timer);
      timer = null;
      failures = 0;
      settle(true);
      return journal;
    },
    /** Resolves when the writes of the record that were asked for are done (tests). */
    settled: () => journal,
  };
}
