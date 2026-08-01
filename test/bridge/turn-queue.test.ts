import { expect, test } from 'vitest';
import type { ChatKey } from '../../src/bridge/interfaces.ts';
import { createTurnQueue } from '../../src/bridge/turn-queue.ts';

const key = (chatId: number, agentId = 'main'): ChatKey => ({
  chatId,
  agentId,
});

/** A task that records enter/exit around a turn of the event loop, so an overlap
 *  shows up as an `enter` landing between another task's `enter` and `exit`. */
function tracker() {
  const log: string[] = [];
  const task = (name: string) => async () => {
    log.push(`${name}:enter`);
    await Promise.resolve();
    log.push(`${name}:exit`);
    return name;
  };
  return { log, task };
}

// Three tasks, not two, because the third one also pins the map cleanup: `c`
// chains onto `b`'s tail, so a drain-time delete that failed to check it still
// owned the slot would drop `b` from the map and let `c` start alongside it.
test('same key runs one turn at a time', async () => {
  const { log, task } = tracker();
  const queue = createTurnQueue();

  await Promise.all([
    queue(key(1), task('a')),
    queue(key(1), task('b')),
    queue(key(1), task('c')),
  ]);

  expect(log).toEqual([
    'a:enter',
    'a:exit',
    'b:enter',
    'b:exit',
    'c:enter',
    'c:exit',
  ]);
});

test('different keys do not wait on each other', async () => {
  const { log, task } = tracker();
  const queue = createTurnQueue();

  // Same chat id, different agent — two bots over one chat run on different
  // threads, so they have no reason to serialize.
  await Promise.all([
    queue(key(1, 'main'), task('a')),
    queue(key(2), task('b')),
    queue(key(1, 'other'), task('c')),
  ]);

  expect(log).toEqual([
    'a:enter',
    'b:enter',
    'c:enter',
    'a:exit',
    'b:exit',
    'c:exit',
  ]);
});

test('a rejecting task rejects its own caller and does not wedge the queue', async () => {
  const { log, task } = tracker();
  const queue = createTurnQueue();

  const boom = queue(key(1), async () => {
    log.push('boom:enter');
    throw new Error('turn blew up');
  });
  const after = queue(key(1), task('after'));

  await expect(boom).rejects.toThrow('turn blew up');
  await expect(after).resolves.toBe('after');
  expect(log).toEqual(['boom:enter', 'after:enter', 'after:exit']);
});
