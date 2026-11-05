import type { IdempotentOperation } from '@xui/ledger-shared';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  abandonPendingWrite,
  browserSessionStorage,
  defaultUuid,
  isLocked,
  loadPendingWrite,
  markUnloading,
  preparePendingWrite,
  runPendingWrite,
  slotOf,
  syncPendingWrite,
  type PendingWrite,
  type PrepareResult,
  type RunResult,
  type SendFn,
} from './pendingWrite.ts';

/**
 * React binding of lib/pendingWrite.ts for one form (one operation on one transaction, or the
 * create form). The state machine decides everything; this hook only keeps the current write in a
 * ref (so a re-render never mints a key), restores an unknown-outcome write from sessionStorage on
 * mount, and handles the page going away:
 * - beforeunload: while a request is in flight or its outcome is unknown, the browser asks first;
 * - pagehide: a request still in flight becomes unknown and is stored, so the next page restores it.
 */
export interface PendingWriteApi<T> {
  /** The current write (null: nothing pending). */
  pending: PendingWrite | null;
  /** In flight or unknown: the form must not change the request. */
  locked: boolean;
  /** Restored from sessionStorage when the page opened (outcome unknown). */
  restored: boolean;
  /** A run (first attempt or automatic retries) is still going: manual retry / abandon come after it. */
  running: boolean;
  /** Submit `body` (the parsed request): same content → same key and body; refused while locked with other content. */
  submit: (body: unknown) => Promise<RunResult<T> | Extract<PrepareResult, { ok: false }>>;
  /** Send the current (unknown / failed) write again, unchanged. */
  retry: () => Promise<RunResult<T> | null>;
  /** Forget the write (the caller confirmed that the user checked the list first). */
  abandon: () => void;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function usePendingWrite<T>(opts: { userId: string | undefined; operation: IdempotentOperation; transactionId: string | null; send: SendFn<T> }): PendingWriteApi<T> {
  const { userId, operation, transactionId } = opts;
  const slot = slotOf(operation, transactionId);
  const ref = useRef<PendingWrite | null>(null);
  const [pending, setPending] = useState<PendingWrite | null>(null);
  const [restored, setRestored] = useState(false);
  const [running, setRunning] = useState(false);
  // The current run: abandon and unmount (the page or the user went away) cancel its automatic retries.
  const run$ = useRef<AbortController | null>(null);
  const send = useRef(opts.send);
  send.current = opts.send;

  const update = useCallback((p: PendingWrite | null) => {
    ref.current = p;
    setPending(p);
  }, []);

  // Restore an unknown outcome of this user and slot (after a reload or coming back to the page).
  useEffect(() => {
    if (!userId) return;
    const p = loadPendingWrite(browserSessionStorage(), userId, slot);
    if (p && !ref.current) {
      update(p);
      setRestored(true);
    }
  }, [userId, slot, update]);

  // Leaving the page with a request in flight or an unknown outcome.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      if (isLocked(ref.current)) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    const onPageHide = () => {
      const p = ref.current;
      if (p?.state === 'sending') syncPendingWrite(browserSessionStorage(), p.userId, slot, markUnloading(p, Date.now()));
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      // Unmounting (in-app navigation) with a request in flight: keep it recoverable, and stop the automatic retries.
      onPageHide();
      run$.current?.abort();
    };
  }, [slot]);

  const run = useCallback(
    async (p: PendingWrite) => {
      run$.current?.abort();
      const ctl = new AbortController();
      run$.current = ctl;
      setRunning(true);
      try {
        return await runPendingWrite<T>(p, (key, body) => send.current(key, body), { now: Date.now, sleep, storage: browserSessionStorage(), signal: ctl.signal }, update);
      } finally {
        if (run$.current === ctl) {
          run$.current = null;
          setRunning(false);
        }
      }
    },
    [update],
  );

  const submit = useCallback(
    async (body: unknown) => {
      if (!userId) throw new Error('not signed in');
      const r = preparePendingWrite(ref.current, { userId, operation, transactionId, body }, { now: Date.now, uuid: defaultUuid });
      if (!r.ok) return r;
      setRestored(false);
      return run(r.pending);
    },
    [userId, operation, transactionId, run],
  );

  const retry = useCallback(async () => {
    const p = ref.current;
    if (!p || p.state === 'sending') return null;
    return run(p);
  }, [run]);

  const abandon = useCallback(() => {
    run$.current?.abort();
    run$.current = null;
    setRunning(false);
    const p = ref.current;
    if (p) abandonPendingWrite(browserSessionStorage(), p.userId, slot);
    setRestored(false);
    update(null);
  }, [slot, update]);

  return { pending, locked: isLocked(pending), restored, running, submit, retry, abandon };
}
