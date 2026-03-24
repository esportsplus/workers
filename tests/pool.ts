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
                busy: 0,
                completed: 0,
                idle: 3,
                queued: 0,
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
});
