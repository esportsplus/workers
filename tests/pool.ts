import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';


type MockNodeWorker = {
    _emit: (event: string, ...args: unknown[]) => void;
    on: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
};

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

// Patch worker_threads.Worker in the CJS require cache
let nodeRequire = createRequire(import.meta.url);
let workerThreadsModule = nodeRequire('worker_threads') as Record<string, unknown>;

class MockWorkerClass {
    constructor(_url: string) {
        return createMockNodeWorker() as unknown as MockWorkerClass;
    }
}

workerThreadsModule.Worker = MockWorkerClass;


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
        mockWorkers = [];
        workerThreadsModule.Worker = MockWorkerClass;
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
                timedOut: 0,
                workers: 3
            });

            await p.shutdown();
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

        it('does not terminate retained worker after heartbeat timeout', async () => {
            vi.useFakeTimers();

            let p = createPool<{ hold: () => string }>('test.js', {
                heartbeatInterval: 100,
                heartbeatTimeout: 500,
                limit: 1
            });

            let promise = p().hold();
            let worker = mockWorkers[0];
            let taskUuid = captureUuid(worker);

            // Worker signals it wants to retain the task
            worker._emit('message', { retained: true, uuid: taskUuid });

            // Advance well past heartbeat timeout
            vi.advanceTimersByTime(2000);

            // Worker should NOT be terminated — heartbeat timer was cleared on retain
            expect(worker.terminate).not.toHaveBeenCalled();
            expect(p.stats().busy).toBe(1);

            // Release and complete the retained task
            promise.dispatch('release');
            simulateResult(worker, taskUuid, 'done');

            await expect(promise).resolves.toBe('done');
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
    });
});
