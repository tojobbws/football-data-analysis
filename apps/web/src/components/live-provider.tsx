'use client';

import { useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from 'react';
import { isWatchable, LIVE, phaseGroup, type LiveSeed, type LiveSnapshot, type LiveState, type PhaseGroup } from '@/lib/live';

// Live scores without reloading the page. One poller for the whole site reads /api/live (a shared,
// edge-cached snapshot) every 15 s while the tab is visible and something on screen is in play or
// about to kick off. Components show the latest numbers; when a match changes phase group
// (kick-off, full time) the page re-renders once so order, tabs and post-match data follow.

const DELAYS = [15_000, 30_000, 60_000];
const STALE_AFTER = 120_000;
const FLASH_MS = 3_000;

interface Watch {
  id: number;
  group: PhaseGroup;
  status: string;
  kickoffAt: string;
  home: string;
  away: string;
}

interface Entry {
  state: LiveState;
  at: number;
}

class LiveStore {
  private entries = new Map<number, Entry>();
  private watches = new Map<number, Watch[]>();
  private flashes = new Map<number, number>();
  private refreshed = new Set<string>();
  private listeners = new Set<() => void>();
  private nextKey = 1;
  version = 0;
  lastOk: number | null = null;
  liveCount: number | null = null;
  announcement = '';

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  private notify() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  watch(w: Watch): () => void {
    const key = this.nextKey++;
    this.watches.set(key, [w]);
    // a value polled long before this page rendered may be older than the server's
    const e = this.entries.get(w.id);
    if (e && Date.now() - e.at > 30_000) this.entries.delete(w.id);
    return () => this.watches.delete(key);
  }

  private allWatches(): Watch[] {
    return [...this.watches.values()].flat();
  }

  shouldPoll(now = Date.now()): boolean {
    return this.allWatches().some((w) => isWatchable({ status_short: this.get(w.id)?.status_short ?? w.status }, w.kickoffAt, now));
  }

  get(id: number): LiveState | undefined {
    return this.entries.get(id)?.state;
  }

  isFlashing(id: number): boolean {
    return (this.flashes.get(id) ?? 0) > Date.now();
  }

  /** Applies a snapshot; returns true when a watched match changed phase group (page must re-render). */
  apply(snap: LiveSnapshot): boolean {
    const now = Date.now();
    const byId = new Map(this.allWatches().map((w) => [w.id, w]));
    const goals: string[] = [];
    for (const m of snap.matches) {
      const prev = this.entries.get(m.id)?.state;
      if (prev && (prev.goals_home !== m.goals_home || prev.goals_away !== m.goals_away) && m.goals_home != null && m.goals_away != null) {
        this.flashes.set(m.id, now + FLASH_MS);
        const w = byId.get(m.id);
        if (w) goals.push(`ประตู! ${w.home} ${m.goals_home}–${m.goals_away} ${w.away}`);
      }
      this.entries.set(m.id, { state: m, at: now });
    }
    if (goals.length) {
      this.announcement = goals.join(' · ');
      setTimeout(() => this.notify(), FLASH_MS + 50); // clear the highlight
    }
    this.liveCount = snap.matches.filter((m) => LIVE.includes(m.status_short)).length;
    this.lastOk = now;

    let refresh = false;
    for (const w of byId.values()) {
      const cur = this.entries.get(w.id)?.state;
      if (!cur) continue;
      const g = phaseGroup(cur.status_short);
      const key = `${w.id}:${g}`;
      if (g !== w.group && !this.refreshed.has(key)) {
        this.refreshed.add(key);
        refresh = true;
      }
    }
    this.notify();
    return refresh;
  }

  tick() {
    this.notify();
  }
}

const Ctx = createContext<LiveStore | null>(null);

export function LiveProvider({ children }: { children: ReactNode }) {
  const [store] = useState(() => new LiveStore());
  const router = useRouter();

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    let stopped = false;
    const schedule = (ms: number) => {
      if (!stopped) timer = setTimeout(run, ms);
    };
    async function run() {
      if (document.visibilityState !== 'visible' || !store.shouldPoll()) return schedule(DELAYS[0]!);
      try {
        const res = await fetch('/api/live', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const snap = (await res.json()) as LiveSnapshot;
        fails = 0;
        if (store.apply(snap)) router.refresh();
      } catch {
        fails++;
        store.tick(); // lets the "อัปเดตล่าสุด" note appear
      }
      schedule(DELAYS[Math.min(fails, DELAYS.length - 1)]!);
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        run();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    schedule(DELAYS[0]!);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [store, router]);

  return (
    <Ctx.Provider value={store}>
      {children}
      <Announcer store={store} />
    </Ctx.Provider>
  );
}

function Announcer({ store }: { store: LiveStore }) {
  useSyncExternalStore(store.subscribe, store.getVersion, () => 0);
  return (
    <div aria-live="polite" role="status" className="sr-only">
      {store.announcement}
    </div>
  );
}

function useStore(): LiveStore | null {
  const store = useContext(Ctx);
  useSyncExternalStore(store?.subscribe ?? noopSubscribe, store?.getVersion ?? zero, zero);
  return store;
}
const noopSubscribe = () => () => {};
const zero = () => 0;

/** Latest state of one match (server values until the first poll), plus whether its score just changed. */
export function useLiveMatch(seed: LiveSeed): { state: LiveState; flash: boolean } {
  const store = useStore();
  const { id, status_short, kickoff_at, home, away } = seed;
  useEffect(() => {
    if (!store) return;
    return store.watch({ id, group: phaseGroup(status_short), status: status_short, kickoffAt: kickoff_at, home, away });
  }, [store, id, status_short, kickoff_at, home, away]);
  const polled = store?.get(id);
  return { state: polled ?? seed, flash: store?.isFlashing(id) ?? false };
}

/** Number of matches in play (server count until the first poll). */
export function useLiveCount(initial: number): number {
  const store = useStore();
  return store?.liveCount ?? initial;
}

/** When polling has failed for a while: the time of the last good read, else null. */
export function useStaleSince(): number | null {
  const store = useStore();
  return store && store.lastOk && store.shouldPoll() && Date.now() - store.lastOk > STALE_AFTER ? store.lastOk : null;
}
