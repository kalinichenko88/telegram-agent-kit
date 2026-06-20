import { describe, expect, test } from 'vitest';

import { DEFAULT_DRAFT_CONSTANTS } from '../../src/draft/constants.ts';
import { createDraftStreamer } from '../../src/draft/index.ts';
import { TelegramApiError } from '../../src/errors.ts';

const DRAFT_MAX_FAILURES = DEFAULT_DRAFT_CONSTANTS.maxFailures;

type Deferred = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (e?: unknown) => void;
};
function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (e?: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = () => res();
    reject = (e) => rej(e);
  });
  return { promise, resolve, reject };
}

const noopLog = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child() {
    return noopLog;
  },
} as never;

function setup(opts: { cancelThrows?: boolean; rich?: boolean } = {}) {
  let clock = 0;
  let tickFn: (() => void) | null = null;
  const cancelInterval = { called: false };
  const drainCancel = { called: false };
  const drafts: Array<{ method: 'rich' | 'plain'; text: string }> = [];
  const typing: number[] = [];
  let lastDraft: Deferred | null = null;
  let drain: Deferred | null = null;

  const record =
    (method: 'rich' | 'plain') =>
    (p: { text?: string; markdown?: string }, signal?: AbortSignal) => {
      drafts.push({ method, text: p.markdown ?? p.text ?? '' });
      const d = deferred();
      lastDraft = d;
      if (signal)
        signal.addEventListener('abort', () => d.reject(new Error('aborted')), {
          once: true,
        });

      return d.promise;
    };

  const streamer = createDraftStreamer({
    chatId: 111,
    draftId: 7,
    rich: opts.rich ?? true,
    log: noopLog,
    client: {
      sendRichMessageDraft: record('rich'),
      sendMessageDraft: record('plain'),
      sendChatAction: async (p: { chatId: number }) => {
        typing.push(p.chatId);
      },
    } as never,
    now: () => clock,
    schedule: (fn: () => void) => {
      tickFn = fn;
      return 1 as never;
    },
    cancel: () => {
      if (opts.cancelThrows) throw new Error('cancel blew up');
      cancelInterval.called = true;
    },
    delay: () => {
      drain = deferred();
      return {
        promise: drain.promise,
        cancel: () => {
          drainCancel.called = true;
        },
      };
    },
  });

  streamer.start();
  return {
    streamer,
    drafts,
    typing,
    cancelInterval,
    drainCancel,
    advance: (ms: number) => {
      clock += ms;
    },
    tick: () => tickFn?.(),
    resolveDraft: () => lastDraft?.resolve(),
    rejectDraft: (e?: unknown) => lastDraft?.reject(e ?? new Error('fail')),
    resolveDrain: () => drain?.resolve(),
    settle: () => new Promise<void>((r) => setTimeout(r, 0)),
  };
}

describe('DraftStreamer', () => {
  test('first push flushes immediately at now()===0', () => {
    const s = setup();
    s.streamer.push('a');
    expect(s.drafts).toEqual([{ method: 'rich', text: 'a' }]);
  });

  test('rich:false (kill-switch) streams a plain draft from the first push', () => {
    const s = setup({ rich: false });
    s.streamer.push('| a |');
    expect(s.drafts).toEqual([{ method: 'plain', text: '| a |' }]);
  });

  test('every write carries the same non-zero draft_id', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft();
    await s.settle();
    s.advance(300);
    s.streamer.push('ab');
    expect(s.drafts.length).toBe(2);
    expect(s.drafts.every((d) => d.method === 'rich')).toBe(true);
  });

  test('throttles content writes by attempt time', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft();
    await s.settle();
    s.streamer.push('ab'); // clock still 0 → throttled
    expect(s.drafts.length).toBe(1);
    s.advance(300);
    s.tick();
    expect(s.drafts.length).toBe(2);
    expect(s.drafts[1]?.text).toBe('ab');
  });

  test('throttles retries after a failure (no storm)', async () => {
    const s = setup();
    s.streamer.push('a'); // send #1 at clock 0
    s.rejectDraft(); // fails — lastSent stays null, but lastAttemptAt was set
    await s.settle();
    s.streamer.push('ab'); // clock still 0 → throttled despite the failure
    expect(s.drafts.length).toBe(1);
    s.advance(300);
    s.tick();
    expect(s.drafts.length).toBe(2); // throttle window elapsed → retry allowed
  });

  test('caps the preview surrogate-safely', () => {
    const hi = setup();
    hi.streamer.push(`${'a'.repeat(3999)}\uD83D${'b'.repeat(1000)}`);
    expect(hi.drafts[0]?.text.length).toBe(3999);
    const plain = setup();
    plain.streamer.push('a'.repeat(5000));
    expect(plain.drafts[0]?.text.length).toBe(4000);
  });

  test('never drafts a whitespace-only preview', () => {
    const s = setup();
    s.streamer.push('   \n ');
    expect(s.drafts.length).toBe(0);
  });

  test('keepalive re-sends the last text past the expiry window', async () => {
    const s = setup();
    s.streamer.push('a');
    s.resolveDraft();
    await s.settle();
    s.advance(20000);
    s.tick();
    expect(s.drafts.length).toBe(2);
    expect(s.drafts[1]?.text).toBe('a');
  });

  test('typing heartbeat fires on start and after the heartbeat window', () => {
    const s = setup(); // setup() auto-starts → initial typing already recorded
    expect(s.typing).toEqual([111]);
    s.advance(4500);
    s.tick();
    expect(s.typing).toEqual([111, 111]);
  });

  test('finalize drains a fast write and cancels the drain timer', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    s.resolveDraft(); // write resolves
    await s.streamer.finalize();
    expect(s.drainCancel.called).toBe(true);
    expect(s.cancelInterval.called).toBe(true);
    expect(s.drafts.length).toBe(1); // no clear send
  });

  test('finalize abandons a slow write at the drain budget', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending, never resolved
    const p = s.streamer.finalize();
    s.resolveDrain(); // budget elapses first → abort + proceed
    await p;
    expect(s.drainCancel.called).toBe(true);
  });

  test('abort cancels locally, sends no clear, and goes silent', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    await s.streamer.abort();
    expect(s.cancelInterval.called).toBe(true);
    expect(s.drafts.length).toBe(1); // no empty-text clear
    s.advance(1000);
    s.streamer.push('b');
    s.tick();
    expect(s.drafts.length).toBe(1); // stopped → nothing more
  });

  test('emits no typing heartbeat after stop', async () => {
    const s = setup();
    s.streamer.push('a');
    await s.streamer.abort();
    const typingBefore = s.typing.length;
    s.advance(4500); // past the typing-heartbeat window
    s.tick();
    expect(s.typing.length).toBe(typingBefore); // !stopped guard → bubble silent
  });

  test('finalize and abort never reject even if teardown throws', async () => {
    const s = setup({ cancelThrows: true });
    await expect(s.streamer.finalize()).resolves.toBeUndefined();
    await expect(s.streamer.abort()).resolves.toBeUndefined();
  });

  test('disables drafts after N failures; typing heartbeat survives', async () => {
    const s = setup(); // auto-started
    for (let i = 0; i < DRAFT_MAX_FAILURES; i++) {
      s.advance(300);
      s.streamer.push('x'.repeat(i + 1));
      s.rejectDraft();
      await s.settle();
    }
    expect(s.drafts.length).toBe(DRAFT_MAX_FAILURES); // bounded — no storm
    const draftsBefore = s.drafts.length;
    const typingBefore = s.typing.length;
    s.advance(4500);
    s.tick();
    expect(s.drafts.length).toBe(draftsBefore); // disabled → no new draft
    expect(s.typing.length).toBeGreaterThan(typingBefore); // bubble still alive
  });

  test('keeps at most one write in flight', async () => {
    const s = setup();
    s.streamer.push('a'); // inFlight pending
    s.advance(300);
    s.tick(); // would send, but inFlight set → blocked
    expect(s.drafts.length).toBe(1);
    s.resolveDraft();
    await s.settle();
    s.advance(300);
    s.streamer.push('ab');
    expect(s.drafts.length).toBe(2);
  });

  test('a 400 flips rich->plain without burning the failure budget', async () => {
    const s = setup({ rich: true });
    s.streamer.push('| a |');
    expect(s.drafts[0]).toEqual({ method: 'rich', text: '| a |' });
    s.rejectDraft(new TelegramApiError(400, "can't parse rich message"));
    await s.settle();
    s.advance(300);
    s.streamer.push('| a | b |');
    expect(s.drafts[1]?.method).toBe('plain'); // degraded for the turn
    // The 400 must NOT have counted toward DRAFT_MAX_FAILURES.
    for (let i = 0; i < DRAFT_MAX_FAILURES; i += 1) {
      s.rejectDraft();
      await s.settle();
      s.advance(300);
      s.streamer.push(`x${i}`);
    }
    expect(s.drafts.length).toBe(2 + DRAFT_MAX_FAILURES - 1);
  });

  test('keepalive re-sends as plain after a 400 rich->plain flip', async () => {
    const s = setup({ rich: true });
    s.streamer.push('| a |'); // rich draft #1
    s.rejectDraft(new TelegramApiError(400, "can't parse rich message"));
    await s.settle();
    s.advance(300);
    s.streamer.push('| a | b |'); // content draft #2, now plain
    expect(s.drafts[1]?.method).toBe('plain');
    s.resolveDraft();
    await s.settle();
    s.advance(20000); // past the keepalive window
    s.tick();
    // The keepalive must use the flipped (plain) mode — never re-send rich
    // markdown Telegram already rejected (which would 400 every ~20s).
    expect(s.drafts.length).toBe(3);
    expect(s.drafts[2]).toEqual({ method: 'plain', text: '| a | b |' });
  });
});
