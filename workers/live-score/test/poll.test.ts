import { describe, expect, it } from 'vitest';
import { pollMinute } from '../src/poll.js';

/** A fake clock: sleep advances time instantly; each poll takes `pollMs`. */
function clock(pollMs = 0) {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    spend: () => {
      t += pollMs;
    },
  };
}

describe('pollMinute', () => {
  it('polls every N seconds within the minute while something is live', async () => {
    const c = clock(1_000);
    const at: number[] = [];
    const res = await pollMinute({ every: 30, now: c.now, sleep: c.sleep, poll: async () => (at.push(c.now()), c.spend(), 3) });
    expect(at).toEqual([0, 30_000]);
    expect(res).toEqual({ polls: 2, failures: 0 });
  });

  it('a failed poll (rate limit) does not end the minute: the next poll is the retry', async () => {
    const c = clock(500);
    let n = 0;
    const res = await pollMinute({
      every: 15,
      now: c.now,
      sleep: c.sleep,
      poll: async () => {
        c.spend();
        n++;
        if (n === 1) throw new Error('Rate limited');
        return 3;
      },
    });
    expect(res).toEqual({ polls: 4, failures: 1 });
  });

  it('stops for the minute when nothing is on', async () => {
    const c = clock();
    const res = await pollMinute({ every: 30, now: c.now, sleep: c.sleep, poll: async () => 0 });
    expect(res.polls).toBe(1);
  });

  it('never starts a poll past the 50 s budget', async () => {
    const c = clock(55_000); // one very slow poll
    const res = await pollMinute({ every: 30, now: c.now, sleep: c.sleep, poll: async () => (c.spend(), 3) });
    expect(res.polls).toBe(1); // the 30 s poll would start at 55 s: skipped, the next minute's run takes over
  });
});
