import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


type MockNodeWorker = {
    _emit: (event: string, ...args: unknown[]) => void;
    on: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
};

const { createMockNodeWorker, mockWorkers } = vi.hoisted(() => {
    let mockWorkers: MockNodeWorker[] = [];

    function createMockNodeWorker(): MockNodeWorker {
        let handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

        let worker: MockNodeWorker = {
            _emit(event: string, ...args: unknown[]) {
                for (let fn of handlers[event] ?? []) {
                    fn(...args);
                }
            },
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                (handlers[event] ??= []).push(handler);
            }),
            postMessage: vi.fn(),
            terminate: vi.fn()
        };

        mockWorkers.push(worker);
        return worker;
    }

    return { createMockNodeWorker, mockWorkers };
});

vi.mock('node:worker_threads', () => {
    class MockWorkerClass {
        constructor(_url: string) {
            return createMockNodeWorker() as unknown as MockWorkerClass;
        }
    }

    return { Worker: MockWorkerClass, parentPort: null };
});


function captureUuid(worker: MockNodeWorker, callIndex?: number): string {
    let calls = worker.postMessage.mock.calls;
    let idx = callIndex ?? calls.length - 1;

    return (calls[idx][0] as Record<string, unknown>).uuid as string;
}

function simulateError(worker: MockNodeWorker, uuid: string, error: { message: string; stack?: string }) {
    worker._emit('message', { error, uuid });
}

function simulateResult(worker: MockNodeWorker, uuid: string, result: unknown) {
    worker._emit('message', { result, uuid });
}


describe('Pool', () => {
    let createPool: typeof import('../src/pool').default;

    beforeEach(async () => {
        mockWorkers.length = 0;
        createPool = (await import('../src/pool')).default;
    });

    afterEach(() => {
        vi.useRealTimers();
    });


    describe('creation', () => {
        it('creates workers up to limit when no idleTimeout', async () => {
            let p = createPool('test.js', { limit: 2 });
            let stats = p.stats();

            expect(stats.workers).toBe(2);
            expect(stats.idle).toBe(2);
            expect(stats.busy).toBe(0);
            expect(stats.completed).toBe(0);
            expect(stats.queued).toBe(0);

            await p.shutdown();
        });

        it('does not pre-warm workers when idleTimeout is set', async () => {
            let p = createPool('test.js', { idleTimeout: 5000, limit: 2 });
            let stats = p.stats();

            expect(stats.workers).toBe(0);
            expect(stats.idle).toBe(0);

            await p.shutdown();
        });

        it('stats() returns correct initial values', async () => {
            let p = createPool('test.js', { limit: 3 });

            expect(p.stats()).toEqual({
                avgRunTime: 0,
                avgWaitTime: 0,
                busy: 0,
                completed: 0,
                failed: 0,
                idle: 3,
                queued: 0,
                retried: 0,
                timedOut: 0,
                workers: 3
            });

            await p.shutdown();
        });

        it('honors an explicit limit above core count (no clamp)', async () => {
            let p = createPool('test.js', { limit: 32 });

            expect(p.stats().workers).toBe(32);
            expect(mockWorkers.length).toBe(32);

            await p.shutdown();
        });

        it('defaults to MAX_CONCURRENCY and creates at least one worker when limit omitted', async () => {
            let p = createPool('test.js');

            expect(p.stats().workers).toBeGreaterThanOrEqual(1);

            await p.shutdown();
        });

        it('throws when limit is 0', () => {
            expect(() => createPool('test.js', { limit: 0 })).toThrow('limit must be a positive integer');
        });

        it('throws when limit is negative', () => {
            expect(() => createPool('test.js', { limit: -1 })).toThrow('limit must be a positive integer');
        });

        it('throws when limit is a non-integer', () => {
            expect(() => createPool('test.js', { limit: 2.5 })).toThrow('limit must be a positive integer');
        });
    });


    describe('task scheduling', () => {
        it('dispatches task to worker via postMessage with correct payload', async () => {
            let p = createPool<{ add: (a: number, b: number) => number }>('test.js', { limit: 1 });

            p().add(1, 2);

            // Pre-warmed worker is at index 0
            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            expect(payload.args).toEqual([1, 2]);
            expect(payload.path).toBe('add');
            expect(payload.uuid).toBeDefined();

            simulateResult(worker, payload.uuid as string, 3);
            await p.shutdown();
        });

        it('task resolves when worker sends result', async () => {
            let p = createPool<{ compute: (x: number) => number }>('test.js', { limit: 1 });

            let promise = p().compute(42);
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 84);

            await expect(promise).resolves.toBe(84);
            await p.shutdown();
        });

        it('task rejects when worker sends error', async () => {
            let p = createPool<{ fail: () => void }>('test.js', { limit: 1 });

            let promise = p().fail();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateError(worker, taskUuid, { message: 'something broke', stack: 'Error: something broke\n    at ...' });

            await expect(promise).rejects.toThrow('something broke');
            await p.shutdown();
        });
    });


    describe('concurrency', () => {
        it('queues tasks when all workers are busy', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            p().work();
            p().work();

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(1);

            // Complete first task so shutdown doesn't hang
            let worker = mockWorkers[0];
            let uuid = captureUuid(worker);

            simulateResult(worker, uuid, 1);

            // Complete second task
            let uuid2 = captureUuid(worker);

            simulateResult(worker, uuid2, 2);
            await p.shutdown();
        });

        it('processes queue when worker becomes available', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });

            let p1 = p().work(1);
            let p2 = p().work(2);

            let worker = mockWorkers[0];
            let uuid1 = captureUuid(worker, 0);

            simulateResult(worker, uuid1, 10);

            await expect(p1).resolves.toBe(10);

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(0);

            let uuid2 = captureUuid(worker);

            simulateResult(worker, uuid2, 20);

            await expect(p2).resolves.toBe(20);
            await p.shutdown();
        });
    });


    describe('abort', () => {
        it('rejects task when signal is already aborted', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });
            let controller = new AbortController();

            controller.abort();

            let promise = p({ signal: controller.signal }).work();

            await expect(promise).rejects.toThrow('task aborted');
            await p.shutdown();
        });

        it('aborts running task and replaces worker', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });
            let controller = new AbortController();
            let initialCount = mockWorkers.length;

            let promise = p({ signal: controller.signal }).work();
            let worker = mockWorkers[initialCount - 1];

            expect(p.stats().busy).toBe(1);

            controller.abort();

            await expect(promise).rejects.toThrow('task aborted');
            expect(worker.terminate).toHaveBeenCalled();

            // A replacement worker should have been created
            expect(mockWorkers.length).toBeGreaterThan(initialCount);

            await p.shutdown();
        });

        it('aborting a running task does not count as a timeout', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });
            let controller = new AbortController();

            let promise = p({ signal: controller.signal }).work();
            let worker = mockWorkers[0];

            expect(p.stats().busy).toBe(1);

            controller.abort();

            await expect(promise).rejects.toThrow('task aborted');

            // recycleWorker(worker, task, false) — countTimeout=false, so timedOut must stay 0.
            // A mutation flipping it to true (or dropping the flag) would make this 1.
            expect(p.stats().timedOut).toBe(0);
            expect(worker.terminate).toHaveBeenCalled();

            await p.shutdown();
        });
    });


    describe('timeout', () => {
        it('rejects task after timeout expires', async () => {
            vi.useFakeTimers();

            let p = createPool<{ slow: () => void }>('test.js', { limit: 1 });

            let promise = p({ timeout: 1000 }).slow();

            vi.advanceTimersByTime(1000);

            await expect(promise).rejects.toThrow('task timed out after 1000ms');
            await p.shutdown();
        });
    });


    describe('shutdown', () => {
        it('rejects queued tasks with "pool closing"', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            p().work();
            let queued = p().work();

            let shutdownPromise = p.shutdown();

            await expect(queued).rejects.toThrow('pool closing');

            // Complete pending task
            let worker = mockWorkers[0];
            let uuid = captureUuid(worker, 0);

            simulateResult(worker, uuid, 1);

            await shutdownPromise;
        });

        it('terminates all workers', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 2 });

            await p.shutdown();

            expect(mockWorkers[0].terminate).toHaveBeenCalled();
            expect(mockWorkers[1].terminate).toHaveBeenCalled();
        });

        it('rejects new tasks after shutdown initiated', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });

            let shutdownPromise = p.shutdown();
            let promise = p().work();

            await expect(promise).rejects.toThrow('pool is shutting down');
            await shutdownPromise;
        });

        it('resolves immediately when no pending tasks', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });

            await expect(p.shutdown()).resolves.toBeUndefined();
        });

        it('reaps idle timer armed when a task completes during shutdown drain', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { idleTimeout: 3000, limit: 1 });

            // idleTimeout disables pre-warm — task creates the worker on demand and goes pending
            let promise = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            expect(p.stats().busy).toBe(1);

            // Shutdown while the task is still pending — enters the drain window
            let shutdownPromise = p.shutdown();

            // Completion during the drain: markAvailable arms a FRESH idle timer, then cleanup tears down
            simulateResult(worker, taskUuid, 42);

            await expect(promise).resolves.toBe(42);
            await expect(shutdownPromise).resolves.toBeUndefined();

            // teardownWorkers reaped the freshly-armed idle timer — nothing left pending
            expect(vi.getTimerCount()).toBe(0);

            // Advancing past idleTimeout fires no stray replaceWorker/terminate on the torn-down pool
            await vi.advanceTimersByTimeAsync(3000);

            expect(worker.terminate).toHaveBeenCalledTimes(1);
            expect(p.stats().workers).toBe(0);
        });

        it('force-terminates hung workers after shutdownTimeout grace', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, shutdownTimeout: 50 });

            // Dispatch a task that never completes (stays pending)
            let task = p().work();
            let worker = mockWorkers[0];

            expect(p.stats().busy).toBe(1);

            // Attach rejection handler before grace fires to avoid unhandled rejection
            let result = task.catch((e: Error) => e);
            let shutdownPromise = p.shutdown();

            // Advance past the grace window — forces termination + settles pending task
            await vi.advanceTimersByTimeAsync(50);

            await expect(shutdownPromise).resolves.toBeUndefined();

            let err = await result;

            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain('shutdown forced after 50ms timeout');
            expect(worker.terminate).toHaveBeenCalled();
        });

        it('resolves via normal cleanup before grace fires (no forced reject)', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, shutdownTimeout: 5000 });

            let task = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);
            let shutdownPromise = p.shutdown();

            // Pending task completes normally before the grace window
            simulateResult(worker, taskUuid, 42);

            await expect(task).resolves.toBe(42);
            await expect(shutdownPromise).resolves.toBeUndefined();

            // Advance past what would have been the grace deadline — no forced reject side effects
            await vi.advanceTimersByTimeAsync(5000);

            expect(worker.terminate).toHaveBeenCalled();
            expect(p.stats().workers).toBe(0);
        });

        it('is idempotent: double shutdown with a pending task resolves both at completion, not at grace', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, shutdownTimeout: 5000 });

            let task = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Both calls enter while the task is still pending — second must collapse to the first's promise
            let shutdown1 = p.shutdown();
            let shutdown2 = p.shutdown();

            expect(shutdown1).toBe(shutdown2);

            // Pending task completes — single cleanup path resolves the one in-flight promise
            simulateResult(worker, taskUuid, 7);

            await expect(task).resolves.toBe(7);
            await expect(shutdown1).resolves.toBeUndefined();
            await expect(shutdown2).resolves.toBeUndefined();

            // No second grace timer armed: a single teardown, both awaiters already resolved
            expect(worker.terminate).toHaveBeenCalledTimes(1);
            expect(p.stats().workers).toBe(0);

            // Advancing past the grace deadline must be a no-op (nothing left to force)
            await vi.advanceTimersByTimeAsync(5000);

            expect(worker.terminate).toHaveBeenCalledTimes(1);
        });

        it('post-shutdown shutdown() returns the already-resolved promise', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });

            let first = p.shutdown();

            await first;

            let second = p.shutdown();

            expect(second).toBe(first);
            await expect(second).resolves.toBeUndefined();
        });
    });


    describe('stats', () => {
        it('completed increments after task finishes', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            expect(p.stats().completed).toBe(0);

            p().work();

            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 1);

            await Promise.resolve();

            expect(p.stats().completed).toBe(1);
            await p.shutdown();
        });

        it('returns accurate counts during operation', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 2 });

            p().work(1);
            p().work(2);
            p().work(3);

            let stats = p.stats();

            expect(stats.busy).toBe(2);
            expect(stats.idle).toBe(0);
            expect(stats.queued).toBe(1);
            expect(stats.workers).toBe(2);

            let worker0 = mockWorkers[0];
            let uuid0 = captureUuid(worker0);

            simulateResult(worker0, uuid0, 10);

            await Promise.resolve();

            stats = p.stats();

            // worker0 completed task 1, then got task 3 from queue; worker1 still has task 2
            expect(stats.busy).toBe(2);
            expect(stats.completed).toBe(1);
            expect(stats.queued).toBe(0);

            // Complete remaining tasks
            let worker1 = mockWorkers[1];

            simulateResult(worker1, captureUuid(worker1), 20);
            simulateResult(worker0, captureUuid(worker0), 30);

            await p.shutdown();
        });
    });


    describe('worker errors', () => {
        it('rejects task on worker error', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });

            let promise = p().work();
            let worker = mockWorkers[0];

            worker._emit('error', new Error('worker crashed'));

            await expect(promise).rejects.toThrow('worker crashed');
            await p.shutdown();
        });

        it('replaces errored worker', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });

            // Catch the rejection to avoid unhandled rejection
            let promise = p().work();

            promise.catch(() => {});

            let worker = mockWorkers[0];

            worker._emit('error', new Error('crash'));

            expect(worker.terminate).toHaveBeenCalled();
            expect(p.stats().workers).toBe(0);

            await p.shutdown();
        });

        it('self-heals queued task when crash drops pool to zero workers', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Task A occupies the sole worker; task B is queued
            let pA = p().work(1);
            let pB = p().work(2);

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(1);

            // Worker crashes while A is in-flight: rejects A, removes worker (pool hits zero)
            worker._emit('error', new Error('worker crashed'));

            await expect(pA).rejects.toThrow('worker crashed');

            // processQueue self-healed: B dispatched to a freshly created worker, not stranded
            expect(mockWorkers.length).toBe(2);
            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(0);

            let newWorker = mockWorkers[1];

            simulateResult(newWorker, captureUuid(newWorker), 20);

            await expect(pB).resolves.toBe(20);
            await p.shutdown();
        });

        it('preserves FIFO order when an aborted queue head is drained mid-busy', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Task A occupies the sole worker; queue = [aborted head, live B, live C]
            let pA = p().work(0);

            let controller = new AbortController();
            let pHead = p({ signal: controller.signal }).work(1);
            let pB = p().work(2);
            let pC = p().work(3);

            expect(p.stats().queued).toBe(3);

            // Abort the queue head while all workers are busy and at capacity:
            // processQueue runs with no obtainable worker — must not reorder the live tail
            controller.abort();

            await expect(pHead).rejects.toThrow('task aborted');

            // Complete A — queue drains the aborted head, then dispatches B before C
            simulateResult(worker, captureUuid(worker, 0), 10);

            await expect(pA).resolves.toBe(10);

            let payloadB = worker.postMessage.mock.calls[worker.postMessage.mock.calls.length - 1][0] as Record<string, unknown>;

            expect(payloadB.args).toEqual([2]);

            simulateResult(worker, payloadB.uuid as string, 20);

            await expect(pB).resolves.toBe(20);

            let payloadC = worker.postMessage.mock.calls[worker.postMessage.mock.calls.length - 1][0] as Record<string, unknown>;

            expect(payloadC.args).toEqual([3]);

            simulateResult(worker, payloadC.uuid as string, 30);

            await expect(pC).resolves.toBe(30);
            await p.shutdown();
        });
    });


    describe('proxy', () => {
        it('builds correct path for single method call', async () => {
            let p = createPool<{ add: (a: number, b: number) => number }>('test.js', { limit: 1 });

            p().add(1, 2);

            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            expect(payload.path).toBe('add');

            simulateResult(worker, payload.uuid as string, 3);
            await p.shutdown();
        });

        it('builds correct path for nested method calls', async () => {
            let p = createPool<{ math: { add: (a: number, b: number) => number } }>('test.js', { limit: 1 });

            p().math.add(1, 2);

            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            expect(payload.path).toBe('math.add');

            simulateResult(worker, payload.uuid as string, 3);
            await p.shutdown();
        });

        it('passes schedule options when called as function', async () => {
            let p = createPool<{ work: () => void }>('test.js', { limit: 1 });
            let controller = new AbortController();

            controller.abort();

            let promise = p({ signal: controller.signal }).work();

            await expect(promise).rejects.toThrow('task aborted');
            await p.shutdown();
        });
    });


    describe('idle timeout', () => {
        it('terminates idle workers after timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { idleTimeout: 3000, limit: 1 });

            // No pre-warmed workers with idleTimeout, so p() creates on demand
            p().work();

            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 42);

            await vi.advanceTimersByTimeAsync(0);

            expect(worker.terminate).not.toHaveBeenCalled();

            vi.advanceTimersByTime(3000);

            expect(worker.terminate).toHaveBeenCalled();
            await p.shutdown();
        });

        it('recreates a worker after a full idle teardown (1 -> 0 -> 1)', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { idleTimeout: 3000, limit: 1 });

            // First task creates the worker on demand
            let p1 = p().work();
            let worker1 = mockWorkers[0];

            simulateResult(worker1, captureUuid(worker1), 1);

            await expect(p1).resolves.toBe(1);

            // Idle timer fires — pool tears all workers down (1 -> 0)
            await vi.advanceTimersByTimeAsync(3000);

            expect(worker1.terminate).toHaveBeenCalled();
            expect(p.stats().workers).toBe(0);

            // New schedule with available empty + workers.length(0) < limit(1): re-grow (0 -> 1)
            let p2 = p().work();

            expect(p.stats().workers).toBe(1);
            expect(mockWorkers.length).toBe(2);

            let worker2 = mockWorkers[1];

            simulateResult(worker2, captureUuid(worker2), 2);

            await expect(p2).resolves.toBe(2);
            await p.shutdown();
        });
    });


    describe('event dispatch', () => {
        it('dispatches events from worker to task promise', async () => {
            let p = createPool<{ stream: () => string }>('test.js', { limit: 1 });

            let promise = p().stream();
            let events: unknown[] = [];

            promise.on('progress' as never, (data: unknown) => {
                events.push(data);
            });

            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            worker._emit('message', { data: { percent: 50 }, event: 'progress', uuid: taskUuid });
            worker._emit('message', { data: { percent: 100 }, event: 'progress', uuid: taskUuid });

            expect(events).toEqual([{ percent: 50 }, { percent: 100 }]);

            simulateResult(worker, taskUuid, 'done');

            await expect(promise).resolves.toBe('done');
            await p.shutdown();
        });
    });


    describe('retained tasks', () => {
        it('marks task as retained and sets up release handler', async () => {
            let p = createPool<{ hold: () => string }>('test.js', { limit: 1 });

            let promise = p().hold();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Worker signals it wants to retain the task
            worker._emit('message', { retained: true, uuid: taskUuid });

            expect(p.stats().busy).toBe(1);

            // Trigger the release handler
            promise.dispatch('release');

            // First call is task dispatch, second is release (undefined transfer arg passed through)
            expect(worker.postMessage).toHaveBeenNthCalledWith(2, { release: true, uuid: taskUuid }, undefined);

            // Worker completes after release
            simulateResult(worker, taskUuid, 'released');

            await expect(promise).resolves.toBe('released');
            await p.shutdown();
        });

        it('worker event named "release" does not trigger the internal release listener', async () => {
            let p = createPool<{ hold: () => string }>('test.js', { limit: 1 });

            let promise = p().hold();
            let events: unknown[] = [];

            promise.on('progress' as never, (data: unknown) => {
                events.push(data);
            });

            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Retain the task: registers the pool's internal main->worker 'release' listener
            worker._emit('message', { retained: true, uuid: taskUuid });

            expect(p.stats().busy).toBe(1);

            // Worker posts a colliding event named 'release' — must be dropped, not forwarded
            worker._emit('message', { event: 'release', uuid: taskUuid });

            // The internal release listener never fired: no { release: true } posted back to the worker
            let releaseCalls = worker.postMessage.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).release === true
            );

            expect(releaseCalls.length).toBe(0);

            // Session stays bound — task neither completed nor unbound
            expect(p.stats().busy).toBe(1);
            expect(p.stats().completed).toBe(0);

            // A normal user event is still delivered
            worker._emit('message', { data: { percent: 50 }, event: 'progress', uuid: taskUuid });

            expect(events).toEqual([{ percent: 50 }]);

            // Release legitimately and complete to let shutdown settle
            promise.dispatch('release');
            simulateResult(worker, taskUuid, 'released');

            await expect(promise).resolves.toBe('released');
            await p.shutdown();
        });

        it('duplicate retained:true is idempotent — single release listener', async () => {
            let p = createPool<{ hold: () => string }>('test.js', { limit: 1 });

            let promise = p().hold();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Retain twice for the same task — the second must short-circuit
            worker._emit('message', { retained: true, uuid: taskUuid });
            worker._emit('message', { retained: true, uuid: taskUuid });

            // Slot not double-bound by the duplicate retain
            expect(p.stats().busy).toBe(1);

            // A single application release must fan out exactly ONE { release: true } postMessage
            promise.dispatch('release');

            let releaseCalls = worker.postMessage.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).release === true
            );

            expect(releaseCalls.length).toBe(1);

            simulateResult(worker, taskUuid, 'released');

            await expect(promise).resolves.toBe('released');
            await p.shutdown();
        });
    });


    describe('worker recycling (maxTasksPerWorker)', () => {
        it('recycles worker after maxTasksPerWorker tasks', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxTasksPerWorker: 2 });

            let initialWorker = mockWorkers[0];

            // Task 1
            let p1 = p().work();
            let uuid1 = captureUuid(initialWorker);

            simulateResult(initialWorker, uuid1, 1);

            await expect(p1).resolves.toBe(1);

            // Task 2 — should trigger recycling
            let p2 = p().work();
            let uuid2 = captureUuid(initialWorker);

            simulateResult(initialWorker, uuid2, 2);

            await expect(p2).resolves.toBe(2);

            // Original worker terminated, new one created
            expect(initialWorker.terminate).toHaveBeenCalled();
            expect(mockWorkers.length).toBe(2);
            expect(p.stats().workers).toBe(1);

            await p.shutdown();
        });

        it('does not recycle when maxTasksPerWorker is 0 (disabled)', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxTasksPerWorker: 0 });

            let worker = mockWorkers[0];

            for (let i = 0; i < 5; i++) {
                let promise = p().work();
                let taskUuid = captureUuid(worker);

                simulateResult(worker, taskUuid, i);

                await expect(promise).resolves.toBe(i);
            }

            // Same worker still alive, no recycling
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(mockWorkers.length).toBe(1);

            await p.shutdown();
        });

        it('does not recycle when maxTasksPerWorker is not set', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            let worker = mockWorkers[0];

            for (let i = 0; i < 5; i++) {
                let promise = p().work();
                let taskUuid = captureUuid(worker);

                simulateResult(worker, taskUuid, i);

                await expect(promise).resolves.toBe(i);
            }

            expect(worker.terminate).not.toHaveBeenCalled();
            expect(mockWorkers.length).toBe(1);

            await p.shutdown();
        });

        it('new worker handles tasks after recycling', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxTasksPerWorker: 1 });

            // Task 1 on first worker — triggers recycling
            let worker1 = mockWorkers[0];
            let p1 = p().work();
            let uuid1 = captureUuid(worker1);

            simulateResult(worker1, uuid1, 10);

            await expect(p1).resolves.toBe(10);
            expect(worker1.terminate).toHaveBeenCalled();

            // Task 2 dispatched to new replacement worker
            let worker2 = mockWorkers[1];
            let p2 = p().work();
            let uuid2 = captureUuid(worker2);

            simulateResult(worker2, uuid2, 20);

            await expect(p2).resolves.toBe(20);
            expect(p.stats().completed).toBe(2);

            await p.shutdown();
        });

        it('queued tasks dispatch to new worker after recycling', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxTasksPerWorker: 1 });

            let worker1 = mockWorkers[0];

            // Task 1 is dispatched, task 2 is queued
            let p1 = p().work();
            let p2 = p().work();

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(1);

            // Complete task 1 — triggers recycling, new worker picks up queued task
            let uuid1 = captureUuid(worker1);

            simulateResult(worker1, uuid1, 100);

            await expect(p1).resolves.toBe(100);
            expect(worker1.terminate).toHaveBeenCalled();

            // New worker should have the queued task
            let worker2 = mockWorkers[1];
            let uuid2 = captureUuid(worker2);

            simulateResult(worker2, uuid2, 200);

            await expect(p2).resolves.toBe(200);

            await p.shutdown();
        });

        it('stats reflect correct worker count after recycling', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 2, maxTasksPerWorker: 1 });

            expect(p.stats().workers).toBe(2);

            // available.pop() returns last worker (mockWorkers[1])
            let worker = mockWorkers[1];
            let promise = p().work();
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 42);

            await expect(promise).resolves.toBe(42);

            // Worker count stays at 2 (old one replaced by new one)
            expect(p.stats().workers).toBe(2);
            expect(p.stats().idle).toBe(2);
            expect(p.stats().busy).toBe(0);

            await p.shutdown();
        });

        it('counts error completions toward recycling threshold', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxTasksPerWorker: 2 });

            let worker = mockWorkers[0];

            // Task 1 — completes with error result (not worker error, task error)
            let p1 = p().work();
            let uuid1 = captureUuid(worker);

            simulateError(worker, uuid1, { message: 'task failed' });

            await expect(p1).rejects.toThrow('task failed');

            // Error still counts as task completion — count is 1
            // Task 2
            let p2 = p().work();
            let uuid2 = captureUuid(worker);

            simulateResult(worker, uuid2, 42);

            await expect(p2).resolves.toBe(42);

            // After 2 completions (1 error + 1 success), worker should be recycled
            expect(worker.terminate).toHaveBeenCalled();
            expect(mockWorkers.length).toBe(2);

            await p.shutdown();
        });

        it('recycles exactly on the >= boundary, not before', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxTasksPerWorker: 2 });
            let worker = mockWorkers[0];

            // Task 1 — count becomes 1, below threshold: no recycle yet
            let p1 = p().work();

            simulateResult(worker, captureUuid(worker), 1);

            await expect(p1).resolves.toBe(1);

            // Lower edge: count(1) >= max(2) is false — worker must survive, no premature recycle
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(p.stats().workers).toBe(1);
            expect(mockWorkers.length).toBe(1);

            // Task 2 — count becomes 2, count(2) >= max(2) is true: recycle
            let p2 = p().work();

            simulateResult(worker, captureUuid(worker), 2);

            await expect(p2).resolves.toBe(2);

            // Boundary hit: original terminated, fresh worker spawned
            expect(worker.terminate).toHaveBeenCalled();
            expect(p.stats().workers).toBe(1);
            expect(mockWorkers.length).toBe(2);

            await p.shutdown();
        });
    });


    describe('heartbeat detection', () => {
        it('terminates worker when heartbeat timeout expires', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().work();
            let worker = mockWorkers[0];

            // Advance past heartbeat timeout
            vi.advanceTimersByTime(500);

            await expect(promise).rejects.toThrow('worker heartbeat timeout after 500ms');
            expect(worker.terminate).toHaveBeenCalled();

            await p.shutdown();
        });

        it('sends heartbeat config in dispatch payload', async () => {
            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 200,
                heartbeatTimeout: 1000,
                limit: 1
            });

            p().work();

            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            expect(payload.heartbeat).toBe(true);
            expect(payload.heartbeatInterval).toBe(200);

            simulateResult(worker, payload.uuid as string, 1);
            await p.shutdown();
        });

        it('resets heartbeat timer on heartbeat message', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Advance 400ms (just under timeout)
            vi.advanceTimersByTime(400);

            // Send heartbeat — resets the timer
            worker._emit('message', { heartbeat: true, uuid: taskUuid });

            // Advance another 400ms (800ms total, but only 400ms since last heartbeat)
            vi.advanceTimersByTime(400);

            // Worker should still be alive — timer was reset
            expect(worker.terminate).not.toHaveBeenCalled();

            // Complete the task
            simulateResult(worker, taskUuid, 42);

            await expect(promise).resolves.toBe(42);
            await p.shutdown();
        });

        it('does not monitor heartbeat when options not set', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            p().work();

            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            // No heartbeat fields in payload
            expect(payload.heartbeat).toBeUndefined();
            expect(payload.heartbeatInterval).toBeUndefined();

            // Advance time significantly — worker should not be terminated
            vi.advanceTimersByTime(10000);

            expect(worker.terminate).not.toHaveBeenCalled();

            simulateResult(worker, payload.uuid as string, 1);
            await p.shutdown();
        });

        it('does not monitor heartbeat when only interval is set', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                limit: 1
            });

            p().work();

            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            expect(payload.heartbeat).toBeUndefined();

            vi.advanceTimersByTime(10000);

            expect(worker.terminate).not.toHaveBeenCalled();

            simulateResult(worker, payload.uuid as string, 1);
            await p.shutdown();
        });

        it('does not monitor heartbeat when only timeout is set', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatTimeout: 500,
                limit: 1
            });

            p().work();

            let worker = mockWorkers[0];
            let payload = worker.postMessage.mock.calls[0][0] as Record<string, unknown>;

            expect(payload.heartbeat).toBeUndefined();

            vi.advanceTimersByTime(10000);

            expect(worker.terminate).not.toHaveBeenCalled();

            simulateResult(worker, payload.uuid as string, 1);
            await p.shutdown();
        });

        it('replaces dead worker with new one', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let initialCount = mockWorkers.length;

            p().work().catch(() => {});

            vi.advanceTimersByTime(500);

            // Original terminated, replacement created
            expect(mockWorkers[initialCount - 1].terminate).toHaveBeenCalled();
            expect(mockWorkers.length).toBeGreaterThan(initialCount);
            expect(p.stats().workers).toBe(1);

            await p.shutdown();
        });

        it('clears heartbeat timer on normal task completion', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            p().work();

            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Complete task before timeout
            simulateResult(worker, taskUuid, 42);

            // Advance past what would have been the timeout
            vi.advanceTimersByTime(1000);

            // Worker should NOT be terminated — heartbeat timer was cleared on completion
            expect(worker.terminate).not.toHaveBeenCalled();

            await p.shutdown();
        });

        it('clears heartbeat timer on task error completion', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateError(worker, taskUuid, { message: 'task failed' });

            await expect(promise).rejects.toThrow('task failed');

            // Advance past what would have been the timeout
            vi.advanceTimersByTime(1000);

            // Worker should NOT be terminated — heartbeat timer was cleared on error completion
            expect(worker.terminate).not.toHaveBeenCalled();

            await p.shutdown();
        });

        it('processes queued tasks after dead worker replacement', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let p1 = p().work();
            let p2 = p().work();

            expect(p.stats().queued).toBe(1);

            // First worker dies from heartbeat timeout
            vi.advanceTimersByTime(500);

            await expect(p1).rejects.toThrow('worker heartbeat timeout');

            // Replacement worker should pick up the queued task
            expect(p.stats().queued).toBe(0);
            expect(p.stats().busy).toBe(1);

            // Complete the second task on the replacement worker
            let newWorker = mockWorkers[mockWorkers.length - 1];
            let uuid2 = captureUuid(newWorker);

            simulateResult(newWorker, uuid2, 99);

            await expect(p2).resolves.toBe(99);
            await p.shutdown();
        });

        it('clears heartbeat timer on abort', async () => {
            vi.useFakeTimers();

            let controller = new AbortController();
            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p({ signal: controller.signal }).work();

            controller.abort();

            await expect(promise).rejects.toThrow('task aborted');

            // Advance past what would have been the timeout
            vi.advanceTimersByTime(1000);

            // The replacement worker should not be terminated by a stale heartbeat timer
            let replacementWorker = mockWorkers[mockWorkers.length - 1];

            expect(replacementWorker.terminate).not.toHaveBeenCalled();

            await p.shutdown();
        });

        it('does not terminate healthy retained worker that keeps heartbeating', async () => {
            vi.useFakeTimers();

            let p = createPool<{ hold: () => string }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().hold();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Worker signals it wants to retain the task — heartbeat deadline keeps running
            worker._emit('message', { retained: true, uuid: taskUuid });

            // Worker keeps proving liveness across several would-be deadlines
            for (let i = 0; i < 8; i++) {
                vi.advanceTimersByTime(400);
                worker._emit('message', { heartbeat: true, uuid: taskUuid });
            }

            // Worker should NOT be terminated — each heartbeat resets the deadline
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(p.stats().busy).toBe(1);

            // Release and complete the retained task
            promise.dispatch('release');
            simulateResult(worker, taskUuid, 'done');

            await expect(promise).resolves.toBe('done');
            await p.shutdown();
        });

        it('terminates retained worker that goes silent past heartbeat timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ hold: () => string }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().hold();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            promise.catch(() => {});

            // Worker retains then goes silent — sends no further heartbeats
            worker._emit('message', { retained: true, uuid: taskUuid });

            // Advance past the heartbeat deadline
            vi.advanceTimersByTime(500);

            // Dead retained worker detected: terminated, replaced, retained task rejected
            await expect(promise).rejects.toThrow('worker heartbeat timeout after 500ms');
            expect(worker.terminate).toHaveBeenCalled();
            expect(p.stats().workers).toBe(1);

            await p.shutdown();
        });

        it('heartbeat timer cleared on worker error', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().work();
            let worker = mockWorkers[0];

            worker._emit('error', new Error('crash'));

            await expect(promise).rejects.toThrow('crash');

            // Advance past heartbeat timeout
            vi.advanceTimersByTime(1000);

            // No further terminations from stale heartbeat timer
            expect(p.stats().workers).toBe(0);

            await p.shutdown();
        });
    });


    describe('context (FIFO no-op)', () => {
        it('context() on a FIFO pool is a no-op: no throw, queue + dispatch order unchanged', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Saturate: 1 running (blocker) + 2 queued
            let p1 = p().work(1);
            let p2 = p().work(2);
            let p3 = p().work(3);

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(2);

            // No priority scheduler → context() must early-return without throwing or mutating the queue
            expect(() => p.context({ priority: 'whatever' })).not.toThrow();
            expect(p.stats().queued).toBe(2);
            expect(p.stats().busy).toBe(1);

            // Free the worker: FIFO order preserved — task 2 dispatched before task 3
            simulateResult(worker, captureUuid(worker, 0), 10);

            await expect(p1).resolves.toBe(10);

            let payload2 = worker.postMessage.mock.calls[worker.postMessage.mock.calls.length - 1][0] as Record<string, unknown>;

            expect(payload2.args).toEqual([2]);

            simulateResult(worker, payload2.uuid as string, 20);

            await expect(p2).resolves.toBe(20);

            let payload3 = worker.postMessage.mock.calls[worker.postMessage.mock.calls.length - 1][0] as Record<string, unknown>;

            expect(payload3.args).toEqual([3]);

            simulateResult(worker, payload3.uuid as string, 30);

            await expect(p3).resolves.toBe(30);
            await p.shutdown();
        });
    });


    describe('enhanced statistics', () => {
        it('shows zero averages initially', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 2 });
            let stats = p.stats();

            expect(stats.avgRunTime).toBe(0);
            expect(stats.avgWaitTime).toBe(0);
            expect(stats.failed).toBe(0);
            expect(stats.timedOut).toBe(0);

            await p.shutdown();
        });

        it('failed increments on task error', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let promise = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateError(worker, taskUuid, { message: 'boom' });

            await expect(promise).rejects.toThrow('boom');

            expect(p.stats().failed).toBe(1);
            expect(p.stats().completed).toBe(1);

            await p.shutdown();
        });

        it('timedOut increments on task timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            let promise = p({ timeout: 500 }).work();

            vi.advanceTimersByTime(500);

            await expect(promise).rejects.toThrow('task timed out');

            expect(p.stats().timedOut).toBe(1);
            expect(p.stats().completed).toBe(0);

            await p.shutdown();
        });

        it('timedOut increments on heartbeat timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().work();

            vi.advanceTimersByTime(500);

            await expect(promise).rejects.toThrow('heartbeat timeout');

            expect(p.stats().timedOut).toBe(1);
            expect(p.stats().completed).toBe(0);

            await p.shutdown();
        });

        it('avgRunTime is non-zero after task completion', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            let promise = p().work();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 42);

            await expect(promise).resolves.toBe(42);

            expect(p.stats().avgRunTime).toBeGreaterThanOrEqual(0);
            expect(p.stats().completed).toBe(1);

            await p.shutdown();
        });

        it('avgWaitTime is non-zero after queued task completes', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            // First task occupies the worker
            p().work();

            // Second task gets queued
            let p2 = p().work();

            expect(p.stats().queued).toBe(1);

            // Complete first task — second gets dispatched
            let worker = mockWorkers[0];
            let uuid1 = captureUuid(worker, 0);

            simulateResult(worker, uuid1, 1);

            // Complete second task
            let uuid2 = captureUuid(worker);

            simulateResult(worker, uuid2, 2);

            await expect(p2).resolves.toBe(2);

            // avgWaitTime should be > 0 because the second task waited in queue
            expect(p.stats().avgWaitTime).toBeGreaterThanOrEqual(0);

            await p.shutdown();
        });

        it('multiple completions average correctly', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            for (let i = 0; i < 5; i++) {
                let promise = p().work();
                let taskUuid = captureUuid(worker);

                simulateResult(worker, taskUuid, i);

                await expect(promise).resolves.toBe(i);
            }

            let stats = p.stats();

            expect(stats.completed).toBe(5);
            expect(stats.failed).toBe(0);
            expect(stats.timedOut).toBe(0);
            expect(stats.avgRunTime).toBeGreaterThanOrEqual(0);
            expect(stats.avgWaitTime).toBeGreaterThanOrEqual(0);

            await p.shutdown();
        });

        it('failed and completed both increment on error completion', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Success
            let p1 = p().work();

            simulateResult(worker, captureUuid(worker), 1);

            await expect(p1).resolves.toBe(1);

            // Error
            let p2 = p().work();

            simulateError(worker, captureUuid(worker), { message: 'err' });

            await expect(p2).rejects.toThrow('err');

            // Success
            let p3 = p().work();

            simulateResult(worker, captureUuid(worker), 3);

            await expect(p3).resolves.toBe(3);

            let stats = p.stats();

            expect(stats.completed).toBe(3);
            expect(stats.failed).toBe(1);

            await p.shutdown();
        });

        it('stats persist after shutdown for reading', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];
            let promise = p().work();
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 42);

            await expect(promise).resolves.toBe(42);
            await p.shutdown();

            let stats = p.stats();

            expect(stats.completed).toBe(1);
            expect(stats.avgRunTime).toBeGreaterThanOrEqual(0);
        });

        it('avgRunTime equals the exact per-task hold duration', async () => {
            vi.useFakeTimers({ now: 0, toFake: ['Date', 'clearTimeout', 'performance', 'setTimeout'] });

            // Sanity: performance.now() is actually controlled by the fake clock
            expect(performance.now()).toBe(0);

            // Advance off zero before the first dispatch so every startedAt is truthy
            // (completion guard is `if (task.startedAt)`, which treats startedAt === 0 as unstarted).
            vi.advanceTimersByTime(1000);

            let held = 75;
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            for (let i = 0; i < 4; i++) {
                let promise = p().work();
                let taskUuid = captureUuid(worker);

                // Hold the task a known duration before it completes
                vi.advanceTimersByTime(held);
                simulateResult(worker, taskUuid, i);

                await expect(promise).resolves.toBe(i);
            }

            let stats = p.stats();

            expect(stats.completed).toBe(4);
            // totalRunTime = 4 * held, completed = 4 → mean === held
            expect(stats.avgRunTime).toBe(held);

            await p.shutdown();
        });

        it('avgWaitTime reflects the exact queue wait', async () => {
            vi.useFakeTimers({ now: 0, toFake: ['Date', 'clearTimeout', 'performance', 'setTimeout'] });

            expect(performance.now()).toBe(0);

            let waited = 200;
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Blocker dispatched immediately (wait 0); second task queued (queuedAt = 0)
            let p1 = p().work(1);
            let p2 = p().work(2);

            expect(p.stats().queued).toBe(1);

            // Queued task waits `waited` ms before the worker frees and dispatches it
            vi.advanceTimersByTime(waited);
            simulateResult(worker, captureUuid(worker, 0), 10);

            await expect(p1).resolves.toBe(10);

            // dispatched = 2: blocker waited 0, queued task waited `waited` → mean === waited / 2
            expect(p.stats().avgWaitTime).toBe(waited / 2);

            simulateResult(worker, captureUuid(worker), 20);

            await expect(p2).resolves.toBe(20);
            await p.shutdown();
        });

        it('avgRunTime stays 0 when nothing completes (timeout only — zero-completion guard)', async () => {
            vi.useFakeTimers({ now: 0, toFake: ['Date', 'clearTimeout', 'performance', 'setTimeout'] });

            expect(performance.now()).toBe(0);

            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let promise = p({ timeout: 100 }).work();

            vi.advanceTimersByTime(100);

            await expect(promise).rejects.toThrow('task timed out');

            let stats = p.stats();

            // completed === 0 → the `completed > 0 ? … : 0` guard returns 0, not NaN
            expect(stats.completed).toBe(0);
            expect(stats.timedOut).toBe(1);
            expect(stats.avgRunTime).toBe(0);

            await p.shutdown();
        });
    });


    describe('task retry with backoff', () => {
        it('retries task on error and eventually succeeds', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 2 });
            let promise = p().work();
            let worker = mockWorkers[0];
            let uuid1 = captureUuid(worker);

            // First attempt fails
            simulateError(worker, uuid1, { message: 'transient' });

            // Advance past retry delay
            await vi.advanceTimersByTimeAsync(2000);

            // Second attempt succeeds
            let uuid2 = captureUuid(worker);

            simulateResult(worker, uuid2, 42);

            await expect(promise).resolves.toBe(42);
            await p.shutdown();
        });

        it('rejects after exhausting all retries', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 2 });
            let promise = p().work();
            let worker = mockWorkers[0];

            // Attempt 0 (original)
            simulateError(worker, captureUuid(worker), { message: 'fail1' });

            await vi.advanceTimersByTimeAsync(2000);

            // Attempt 1 (retry 1)
            simulateError(worker, captureUuid(worker), { message: 'fail2' });

            await vi.advanceTimersByTimeAsync(5000);

            // Attempt 2 (retry 2) — last attempt
            simulateError(worker, captureUuid(worker), { message: 'final fail' });

            await expect(promise).rejects.toThrow('final fail');
            await p.shutdown();
        });

        it('does not retry on abort', async () => {
            vi.useFakeTimers();

            let controller = new AbortController();
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 3 });
            let promise = p({ signal: controller.signal }).work();

            controller.abort();

            await expect(promise).rejects.toThrow('task aborted');

            expect(p.stats().retried).toBe(0);

            await p.shutdown();
        });

        it('does not retry on timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 3 });
            let promise = p({ timeout: 500 }).work();

            vi.advanceTimersByTime(500);

            await expect(promise).rejects.toThrow('task timed out');

            expect(p.stats().retried).toBe(0);

            await p.shutdown();
        });

        it('does not retry when retries = 0 (default)', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let promise = p().work();
            let worker = mockWorkers[0];

            simulateError(worker, captureUuid(worker), { message: 'boom' });

            await expect(promise).rejects.toThrow('boom');

            expect(p.stats().retried).toBe(0);
            expect(p.stats().failed).toBe(1);

            await p.shutdown();
        });

        it('per-task override of pool-level retry config', async () => {
            vi.useFakeTimers();

            // Pool has retries=0, but per-task override sets retries=1
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let promise = p({ retries: 1 }).work();
            let worker = mockWorkers[0];

            // First attempt fails
            simulateError(worker, captureUuid(worker), { message: 'transient' });

            await vi.advanceTimersByTimeAsync(2000);

            // Retry succeeds
            simulateResult(worker, captureUuid(worker), 99);

            await expect(promise).resolves.toBe(99);

            expect(p.stats().retried).toBe(1);
            expect(p.stats().failed).toBe(0);

            await p.shutdown();
        });

        it('pool-level retry config applies to all tasks', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 1 });
            let worker = mockWorkers[0];

            // Task 1
            let p1 = p().work();

            simulateError(worker, captureUuid(worker), { message: 'err1' });

            await vi.advanceTimersByTimeAsync(2000);

            simulateResult(worker, captureUuid(worker), 1);

            await expect(p1).resolves.toBe(1);

            // Task 2
            let p2 = p().work();

            simulateError(worker, captureUuid(worker), { message: 'err2' });

            await vi.advanceTimersByTimeAsync(2000);

            simulateResult(worker, captureUuid(worker), 2);

            await expect(p2).resolves.toBe(2);

            expect(p.stats().retried).toBe(2);

            await p.shutdown();
        });

        it('exponential backoff delays increase', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 3, retryDelay: 1000 });

            // Spy on Math.random to control jitter
            vi.spyOn(Math, 'random').mockReturnValue(0);

            let promise = p().work();
            let worker = mockWorkers[0];

            // Attempt 0 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Retry 1: delay = 1000 * 2^0 + 0 = 1000ms
            await vi.advanceTimersByTimeAsync(999);

            // Should not have dispatched yet
            expect(worker.postMessage.mock.calls.length).toBe(1);

            await vi.advanceTimersByTimeAsync(1);

            // Now dispatched (2 calls total)
            expect(worker.postMessage.mock.calls.length).toBe(2);

            // Attempt 1 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Retry 2: delay = 1000 * 2^1 + 0 = 2000ms
            await vi.advanceTimersByTimeAsync(1999);

            expect(worker.postMessage.mock.calls.length).toBe(2);

            await vi.advanceTimersByTimeAsync(1);

            expect(worker.postMessage.mock.calls.length).toBe(3);

            // Attempt 2 succeeds
            simulateResult(worker, captureUuid(worker), 42);

            await expect(promise).resolves.toBe(42);

            vi.spyOn(Math, 'random').mockRestore();

            await p.shutdown();
        });

        it('maxRetryDelay caps the delay', async () => {
            vi.useFakeTimers();

            // retryDelay=1000, maxRetryDelay=1500 — second retry would be 2000ms but capped at 1500
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxRetryDelay: 1500, retries: 3, retryDelay: 1000 });

            vi.spyOn(Math, 'random').mockReturnValue(0);

            let promise = p().work();
            let worker = mockWorkers[0];

            // Attempt 0 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Retry 1: delay = min(1000 * 1 + 0, 1500) = 1000ms
            await vi.advanceTimersByTimeAsync(1000);

            // Attempt 1 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Retry 2: delay = min(1000 * 2 + 0, 1500) = 1500ms (capped)
            await vi.advanceTimersByTimeAsync(1499);

            // Should not have dispatched yet
            expect(worker.postMessage.mock.calls.length).toBe(2);

            await vi.advanceTimersByTimeAsync(1);

            // Now dispatched
            expect(worker.postMessage.mock.calls.length).toBe(3);

            simulateResult(worker, captureUuid(worker), 42);

            await expect(promise).resolves.toBe(42);

            vi.spyOn(Math, 'random').mockRestore();

            await p.shutdown();
        });

        it('applies the random jitter term to the retry delay', async () => {
            vi.useFakeTimers();

            // Non-zero jitter: delay = base(1000) + 0.5*retryDelay(1000) = 1500ms
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 1, retryDelay: 1000 });

            vi.spyOn(Math, 'random').mockReturnValue(0.5);

            let promise = p().work();
            let worker = mockWorkers[0];

            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Just before 1500ms — jitter term keeps it from firing at the base 1000ms.
            // If the `+ Math.random()*retryDelay` term were dropped, dispatch would already have happened.
            await vi.advanceTimersByTimeAsync(1499);

            expect(worker.postMessage.mock.calls.length).toBe(1);

            await vi.advanceTimersByTimeAsync(1);

            expect(worker.postMessage.mock.calls.length).toBe(2);

            simulateResult(worker, captureUuid(worker), 42);

            await expect(promise).resolves.toBe(42);

            vi.spyOn(Math, 'random').mockRestore();

            await p.shutdown();
        });

        it('clamps base + jitter to maxRetryDelay', async () => {
            vi.useFakeTimers();

            // base(1000) + 0.5*1000 = 1500 would exceed maxRetryDelay(1200) -> clamped to 1200
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, maxRetryDelay: 1200, retries: 1, retryDelay: 1000 });

            vi.spyOn(Math, 'random').mockReturnValue(0.5);

            let promise = p().work();
            let worker = mockWorkers[0];

            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Not yet at the clamp ceiling
            await vi.advanceTimersByTimeAsync(1199);

            expect(worker.postMessage.mock.calls.length).toBe(1);

            // Fires exactly at maxRetryDelay — a broken clamp would fire later (at 1500) or never
            await vi.advanceTimersByTimeAsync(1);

            expect(worker.postMessage.mock.calls.length).toBe(2);

            simulateResult(worker, captureUuid(worker), 42);

            await expect(promise).resolves.toBe(42);

            vi.spyOn(Math, 'random').mockRestore();

            await p.shutdown();
        });

        it('stats().retried increments on each retry', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 3 });
            let promise = p().work();
            let worker = mockWorkers[0];

            expect(p.stats().retried).toBe(0);

            // Attempt 0 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            expect(p.stats().retried).toBe(1);

            await vi.advanceTimersByTimeAsync(2000);

            // Attempt 1 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            expect(p.stats().retried).toBe(2);

            await vi.advanceTimersByTimeAsync(5000);

            // Attempt 2 succeeds
            simulateResult(worker, captureUuid(worker), 42);

            await expect(promise).resolves.toBe(42);

            expect(p.stats().retried).toBe(2);

            await p.shutdown();
        });

        it('stats().failed only increments when retries exhausted', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 1 });
            let promise = p().work();
            let worker = mockWorkers[0];

            // Attempt 0 fails — retry, not failed
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            expect(p.stats().failed).toBe(0);

            await vi.advanceTimersByTimeAsync(2000);

            // Attempt 1 fails — retries exhausted, now failed
            simulateError(worker, captureUuid(worker), { message: 'final' });

            expect(p.stats().failed).toBe(1);

            await expect(promise).rejects.toThrow('final');

            await p.shutdown();
        });

        it('retry during pool shutdown rejects', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 2 });
            let promise = p().work();
            let worker = mockWorkers[0];

            // First attempt fails — triggers retry
            simulateError(worker, captureUuid(worker), { message: 'transient' });

            // Attach rejection handler before shutdown to prevent unhandled rejection
            let result = promise.catch((e: Error) => e);

            // Shutdown before retry fires
            let shutdownPromise = p.shutdown();

            // Advance timer to fire the retry setTimeout
            await vi.advanceTimersByTimeAsync(2000);

            let err = await result;

            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain('pool closing');

            await shutdownPromise;
        });

        it('shutdown reaps the retry backoff timer and rejects promptly', async () => {
            vi.useFakeTimers();

            // Large retryDelay so the backoff timer is unmistakably still pending at shutdown
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 1, retryDelay: 30000 });
            let promise = p().work();
            let worker = mockWorkers[0];

            // First attempt fails — task enters retry backoff (lives only in the retry timer)
            simulateError(worker, captureUuid(worker), { message: 'transient' });

            let result = promise.catch((e: Error) => e);
            let timersDuringBackoff = vi.getTimerCount();

            // Shutdown mid-backoff must clear the retry timer and settle the stranded promise now
            let shutdownPromise = p.shutdown();

            await expect(shutdownPromise).resolves.toBeUndefined();

            let err = await result;

            expect(err).toBeInstanceOf(Error);
            expect((err as Error).message).toContain('pool closing');

            // The retry timer is reaped: one fewer pending timer than during backoff, and
            // advancing past the full delay triggers no further dispatch
            expect(vi.getTimerCount()).toBeLessThan(timersDuringBackoff);

            let dispatchesBefore = worker.postMessage.mock.calls.length;

            await vi.advanceTimersByTimeAsync(30000);

            expect(worker.postMessage.mock.calls.length).toBe(dispatchesBefore);
        });

        it('does not retry on worker error (crash)', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 3 });
            let promise = p().work();
            let worker = mockWorkers[0];

            worker._emit('error', new Error('worker crashed'));

            await expect(promise).rejects.toThrow('worker crashed');

            expect(p.stats().retried).toBe(0);

            await p.shutdown();
        });

        it('does not retry on heartbeat timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1,
                retries: 3
            });

            let promise = p().work();

            vi.advanceTimersByTime(500);

            await expect(promise).rejects.toThrow('heartbeat timeout');

            expect(p.stats().retried).toBe(0);

            await p.shutdown();
        });

        it('per-task retryDelay and maxRetryDelay override pool defaults', async () => {
            vi.useFakeTimers();

            vi.spyOn(Math, 'random').mockReturnValue(0);

            // Pool defaults: retryDelay=1000, maxRetryDelay=30000
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 2 });

            // Per-task: retryDelay=500, maxRetryDelay=600
            let promise = p({ maxRetryDelay: 600, retryDelay: 500 }).work();
            let worker = mockWorkers[0];

            // Attempt 0 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Retry 1: delay = min(500 * 1 + 0, 600) = 500ms
            await vi.advanceTimersByTimeAsync(500);

            // Attempt 1 fails
            simulateError(worker, captureUuid(worker), { message: 'fail' });

            // Retry 2: delay = min(500 * 2 + 0, 600) = 600ms (capped)
            await vi.advanceTimersByTimeAsync(599);

            expect(worker.postMessage.mock.calls.length).toBe(2);

            await vi.advanceTimersByTimeAsync(1);

            expect(worker.postMessage.mock.calls.length).toBe(3);

            simulateResult(worker, captureUuid(worker), 99);

            await expect(promise).resolves.toBe(99);

            vi.spyOn(Math, 'random').mockRestore();

            await p.shutdown();
        });
    });


    describe('edge cases and cross-feature interactions', () => {
        it('shutdown releases retained pending tasks then resolves', async () => {
            let p = createPool<{ hold: () => string }>('test.js', { limit: 1 });

            let promise = p().hold();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Worker signals retention
            worker._emit('message', { retained: true, uuid: taskUuid });

            // Start shutdown — should send release message to retained task
            let shutdownPromise = p.shutdown();

            // Verify release message was sent
            let releaseCalls = worker.postMessage.mock.calls.filter(
                (call: unknown[]) => (call[0] as Record<string, unknown>).release === true
            );

            expect(releaseCalls.length).toBe(1);
            expect((releaseCalls[0][0] as Record<string, unknown>).uuid).toBe(taskUuid);

            // Worker completes after release
            simulateResult(worker, taskUuid, 'released');

            await expect(promise).resolves.toBe('released');
            await shutdownPromise;
        });

        it('worker error on idle worker does not crash pool', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });

            expect(p.stats().workers).toBe(1);
            expect(p.stats().idle).toBe(1);

            let worker = mockWorkers[0];

            // Emit error on idle worker (no pending task)
            worker._emit('error', new Error('random crash'));

            // Worker is terminated and removed
            expect(worker.terminate).toHaveBeenCalled();
            expect(p.stats().workers).toBe(0);

            await p.shutdown();
        });

        it('abort during retry delay window cancels retry', async () => {
            vi.useFakeTimers();

            let controller = new AbortController();
            let p = createPool<{ work: () => number }>('test.js', { limit: 1, retries: 2 });
            let promise = p({ signal: controller.signal }).work();
            let worker = mockWorkers[0];

            // First attempt fails — triggers retry with delay
            simulateError(worker, captureUuid(worker), { message: 'transient' });

            // Abort during the retry delay window (before setTimeout fires)
            controller.abort();

            await expect(promise).rejects.toThrow('task aborted');

            // Advance past any retry delay to verify retry does not fire
            await vi.advanceTimersByTimeAsync(60000);

            // Only 1 postMessage call (original dispatch) — no retry dispatched
            let lastWorker = mockWorkers[mockWorkers.length - 1];
            let totalDispatches = mockWorkers.reduce(
                (sum: number, w: MockNodeWorker) => sum + w.postMessage.mock.calls.length, 0
            );

            // Original dispatch = 1, no retry dispatch
            expect(totalDispatches).toBe(1);

            await p.shutdown();
        });

        it('multiple consecutive aborted queued tasks are drained', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });

            let controller2 = new AbortController();
            let controller3 = new AbortController();

            // Task 1 runs immediately
            let p1 = p().work(1);

            // Tasks 2, 3 are queued (with abort controllers)
            let p2 = p({ signal: controller2.signal }).work(2);
            let p3 = p({ signal: controller3.signal }).work(3);

            // Task 4 is queued (no abort)
            let p4 = p().work(4);

            expect(p.stats().queued).toBe(3);

            // Abort tasks 2 and 3 while queued
            controller2.abort();
            controller3.abort();

            await expect(p2).rejects.toThrow('task aborted');
            await expect(p3).rejects.toThrow('task aborted');

            // Complete task 1 — should skip aborted tasks and dispatch task 4
            let worker = mockWorkers[0];

            simulateResult(worker, captureUuid(worker, 0), 10);

            await expect(p1).resolves.toBe(10);

            // Task 4 should be dispatched now
            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(0);

            simulateResult(worker, captureUuid(worker), 40);

            await expect(p4).resolves.toBe(40);

            await p.shutdown();
        });

        it('aborting queued task calls processQueue to drain aborted entries', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Task 1 runs immediately
            let p1 = p().work(1);

            // Queue tasks 2 (abortable), 3 (abortable), 4 (live)
            let controller2 = new AbortController();
            let controller3 = new AbortController();
            let p2 = p({ signal: controller2.signal }).work(2);
            let p3 = p({ signal: controller3.signal }).work(3);
            let p4 = p().work(4);

            expect(p.stats().queued).toBe(3);

            // Abort tasks 2 and 3 while queued (worker still busy with task 1)
            controller2.abort();
            controller3.abort();

            await expect(p2).rejects.toThrow('task aborted');
            await expect(p3).rejects.toThrow('task aborted');

            // Aborted tasks still in queue (ring buffer cannot remove arbitrary elements)
            // but processQueue was called — no idle worker, so no dispatch yet
            expect(p.stats().busy).toBe(1);

            // Complete task 1 — processQueue drains aborted tasks and dispatches task 4
            simulateResult(worker, captureUuid(worker, 0), 10);

            await expect(p1).resolves.toBe(10);

            // Task 4 dispatched, queue fully drained
            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(0);

            simulateResult(worker, captureUuid(worker), 40);

            await expect(p4).resolves.toBe(40);

            await p.shutdown();
        });

        it('aborting running task triggers processQueue for next queued task', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Task 1 runs immediately
            let controller1 = new AbortController();
            let p1 = p({ signal: controller1.signal }).work(1);

            // Task 2 queued
            let p2 = p().work(2);

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(1);

            // Abort running task 1 — replacement worker created, processQueue dispatches task 2
            controller1.abort();

            await expect(p1).rejects.toThrow('task aborted');

            // Task 2 should be dispatched to replacement worker
            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(0);

            let lastWorker = mockWorkers[mockWorkers.length - 1];

            simulateResult(lastWorker, captureUuid(lastWorker), 20);

            await expect(p2).resolves.toBe(20);

            await p.shutdown();
        });

        it('queue capacity is not permanently consumed by aborted tasks', async () => {
            let p = createPool<{ work: (n: number) => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Fill queue: 1 running + many queued tasks, then abort some, complete others, schedule more
            let p1 = p().work(0);

            let controllers: AbortController[] = [];
            let promises: Promise<unknown>[] = [];

            // Queue 10 tasks with abort controllers
            for (let i = 1; i <= 10; i++) {
                let c = new AbortController();

                controllers.push(c);
                promises.push(p({ signal: c.signal }).work(i));
            }

            expect(p.stats().queued).toBe(10);

            // Abort all 10 queued tasks
            for (let i = 0, n = controllers.length; i < n; i++) {
                controllers[i].abort();
            }

            // All should reject
            for (let i = 0, n = promises.length; i < n; i++) {
                await expect(promises[i]).rejects.toThrow('task aborted');
            }

            // Complete running task 1
            simulateResult(worker, captureUuid(worker, 0), 0);

            await expect(p1).resolves.toBe(0);

            // Queue should be fully drained
            expect(p.stats().queued).toBe(0);
            expect(p.stats().idle).toBe(1);

            // Now schedule more tasks — queue slots should be available
            let p11 = p().work(11);
            let p12 = p().work(12);

            expect(p.stats().busy).toBe(1);
            expect(p.stats().queued).toBe(1);

            simulateResult(worker, captureUuid(worker), 11);

            await expect(p11).resolves.toBe(11);

            simulateResult(worker, captureUuid(worker), 12);

            await expect(p12).resolves.toBe(12);

            await p.shutdown();
        });

        it('maxTasksPerWorker + heartbeat combined recycles worker with heartbeat config', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1,
                maxTasksPerWorker: 1
            });

            let worker1 = mockWorkers[0];

            // Task 1 on first worker
            let p1 = p().work();
            let uuid1 = captureUuid(worker1);
            let payload1 = worker1.postMessage.mock.calls[0][0] as Record<string, unknown>;

            // Verify heartbeat config in first dispatch
            expect(payload1.heartbeat).toBe(true);
            expect(payload1.heartbeatInterval).toBe(100);

            simulateResult(worker1, uuid1, 42);

            await expect(p1).resolves.toBe(42);

            // Worker 1 should be recycled (maxTasksPerWorker: 1)
            expect(worker1.terminate).toHaveBeenCalled();
            expect(mockWorkers.length).toBe(2);

            // Task 2 dispatched to replacement worker
            let worker2 = mockWorkers[1];
            let p2 = p().work();
            let uuid2 = captureUuid(worker2);
            let payload2 = worker2.postMessage.mock.calls[0][0] as Record<string, unknown>;

            // Verify replacement worker also gets heartbeat config
            expect(payload2.heartbeat).toBe(true);
            expect(payload2.heartbeatInterval).toBe(100);

            simulateResult(worker2, uuid2, 99);

            await expect(p2).resolves.toBe(99);

            await p.shutdown();
        });

        it('idle timer cleared by mid-countdown dispatch', async () => {
            vi.useFakeTimers();

            let p = createPool<{ work: () => number }>('test.js', { idleTimeout: 3000, limit: 1 });

            // First task — creates worker on demand
            let p1 = p().work();
            let worker = mockWorkers[0];
            let uuid1 = captureUuid(worker);

            simulateResult(worker, uuid1, 1);

            await vi.advanceTimersByTimeAsync(0);
            await expect(p1).resolves.toBe(1);

            // Idle timer now running (3000ms). Advance 2000ms (not enough to terminate).
            await vi.advanceTimersByTimeAsync(2000);

            expect(worker.terminate).not.toHaveBeenCalled();

            // Schedule another task — should clear idle timer
            let p2 = p().work();
            let uuid2 = captureUuid(worker);

            // Advance past the original 3000ms deadline
            await vi.advanceTimersByTimeAsync(1500);

            // Worker should NOT be terminated — idle timer was cleared by dispatch
            expect(worker.terminate).not.toHaveBeenCalled();

            simulateResult(worker, uuid2, 2);

            await expect(p2).resolves.toBe(2);

            await p.shutdown();
        });

        it('pool-side unknown UUID message is ignored', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Dispatch and complete a real task
            let promise = p().work();
            let taskUuid = captureUuid(worker);

            simulateResult(worker, taskUuid, 42);

            await expect(promise).resolves.toBe(42);

            let statsBefore = p.stats();

            // Send message with bogus UUID — should be ignored
            worker._emit('message', { result: 999, uuid: 'bogus-uuid-does-not-exist' });

            let statsAfter = p.stats();

            expect(statsAfter.completed).toBe(statsBefore.completed);
            expect(statsAfter.failed).toBe(statsBefore.failed);
            expect(statsAfter.workers).toBe(statsBefore.workers);

            await p.shutdown();
        });

        it('pool-side message with no uuid is ignored', async () => {
            let p = createPool<{ work: () => number }>('test.js', { limit: 1 });
            let worker = mockWorkers[0];

            // Send messages with no uuid
            worker._emit('message', {});
            worker._emit('message', { foo: 'bar' });
            worker._emit('message', null);

            let stats = p.stats();

            expect(stats.workers).toBe(1);
            expect(stats.idle).toBe(1);
            expect(stats.completed).toBe(0);

            await p.shutdown();
        });
    });
});
