import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { priority, PriorityQueue } from '../src/schedule';
import { Task } from '../src/types';


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

let nodeRequire = createRequire(import.meta.url);
let workerThreadsModule = nodeRequire('worker_threads') as Record<string, unknown>;

class MockWorkerClass {
    constructor(_url: string) {
        return createMockNodeWorker() as unknown as MockWorkerClass;
    }
}

workerThreadsModule.Worker = MockWorkerClass;


// The args[0] of the i-th task the worker was handed — i.e. the dispatch order, by the id we submit.
function dispatchedId(worker: MockNodeWorker, callIndex: number): unknown {
    return (worker.postMessage.mock.calls[callIndex][0] as { args: unknown[] }).args[0];
}

function captureUuid(worker: MockNodeWorker, callIndex: number): string {
    return (worker.postMessage.mock.calls[callIndex][0] as Record<string, unknown>).uuid as string;
}

// Resolve the task dispatched at `callIndex` on `worker`, freeing it so the pool dispatches the next.
function complete(worker: MockNodeWorker, callIndex: number): void {
    worker._emit('message', { result: null, uuid: captureUuid(worker, callIndex) });
}


describe('Pool priority scheduling', () => {
    let createPool: typeof import('../src/pool').default;

    beforeEach(async () => {
        mockWorkers = [];
        workerThreadsModule.Worker = MockWorkerClass;
        createPool = (await import('../src/pool')).default;
    });

    afterEach(() => {
        vi.useRealTimers();
    });


    it('dispatches queued tasks in ascending compare(meta) order, not FIFO', async () => {
        let workers = createPool<{ run: (id: number) => Promise<void> }>('test.js', {
            limit: 1,
            schedule: priority<{ d: number }, Record<string, never>>({
                compare: (meta) => meta.d,
                context: {}
            })
        });
        let worker = mockWorkers[0];

        // First task occupies the single worker; the next three queue out of priority order.
        workers({ meta: { d: 5 } }).run(1);
        workers({ meta: { d: 50 } }).run(2);
        workers({ meta: { d: 10 } }).run(3);
        workers({ meta: { d: 30 } }).run(4);

        expect(worker.postMessage).toHaveBeenCalledTimes(1);
        expect(dispatchedId(worker, 0)).toBe(1);

        // Free the worker repeatedly: the queued three dispatch nearest-first (10 -> 30 -> 50).
        complete(worker, 0);
        expect(dispatchedId(worker, 1)).toBe(3);

        complete(worker, 1);
        expect(dispatchedId(worker, 2)).toBe(4);

        complete(worker, 2);
        expect(dispatchedId(worker, 3)).toBe(2);

        complete(worker, 3);
        await workers.shutdown();
    });

    it('context() re-ranks queued tasks against the updated context', async () => {
        let workers = createPool<{ run: (id: number) => Promise<void> }>('test.js', {
            limit: 1,
            schedule: priority<{ k: number }, { x: number }>({
                compare: (meta, ctx) => Math.abs(meta.k - ctx.x),
                context: { x: 0 }
            })
        });
        let worker = mockWorkers[0];

        // Blocker occupies the worker; k=100 and k=200 queue (at x=0, k=100 is nearer).
        workers({ meta: { k: 0 } }).run(0);
        workers({ meta: { k: 100 } }).run(100);
        workers({ meta: { k: 200 } }).run(200);

        // Move the context to x=200 -> k=200 becomes nearest among the pending pair.
        workers.context({ x: 200 });

        complete(worker, 0);
        expect(dispatchedId(worker, 1)).toBe(200);

        complete(worker, 1);
        expect(dispatchedId(worker, 2)).toBe(100);

        complete(worker, 2);
        await workers.shutdown();
    });

    it('stays FIFO with no scheduler, even when meta is supplied', async () => {
        let workers = createPool<{ run: (id: number) => Promise<void> }>('test.js', { limit: 1 });
        let worker = mockWorkers[0];

        workers({ meta: { d: 5 } }).run(1);
        workers({ meta: { d: 50 } }).run(2);
        workers({ meta: { d: 10 } }).run(3);

        expect(dispatchedId(worker, 0)).toBe(1);

        complete(worker, 0);
        expect(dispatchedId(worker, 1)).toBe(2);

        complete(worker, 1);
        expect(dispatchedId(worker, 2)).toBe(3);

        complete(worker, 2);
        await workers.shutdown();
    });

    it('throws when compare returns NaN for a queued task', async () => {
        let workers = createPool<{ run: (id: number) => Promise<void> }>('test.js', {
            limit: 1,
            schedule: priority<{ d: number }, Record<string, never>>({
                compare: (meta) => meta.d,
                context: {}
            })
        });
        let worker = mockWorkers[0];

        // Blocker saturates the single worker so the next submission is QUEUED (runs add on the heap).
        workers({ meta: { d: 5 } }).run(0);

        expect(() => workers({ meta: { d: NaN } }).run(1)).toThrow('PriorityQueue: compare returned NaN');

        complete(worker, 0);
        await workers.shutdown();
    });

    it('throws when context() reprioritizes a queued task to a NaN key', async () => {
        let workers = createPool<{ run: (id: number) => Promise<void> }>('test.js', {
            limit: 1,
            schedule: priority<{ k: number }, { x: number }>({
                compare: (meta, ctx) => meta.k - ctx.x,
                context: { x: 0 }
            })
        });
        let worker = mockWorkers[0];

        // Blocker saturates the worker; the next task queues with a finite key (k=Infinity, x=0 -> Infinity).
        let blocker = workers({ meta: { k: 0 } }).run(0),
            queued = workers({ meta: { k: Infinity } }).run(1);

        // x=Infinity makes the queued task's key Infinity - Infinity = NaN on re-rank.
        expect(() => workers.context({ x: Infinity })).toThrow('PriorityQueue: compare returned NaN');

        // The queued task survives in the heap with a NaN key; free the worker so it dispatches, then drain.
        complete(worker, 0);
        complete(worker, 1);

        await Promise.allSettled([blocker, queued, workers.shutdown()]);
    });

    it('skips an aborted queued task at dequeue and dispatches the next by priority', async () => {
        let workers = createPool<{ run: (id: number) => Promise<void> }>('test.js', {
            limit: 1,
            schedule: priority<{ d: number }, Record<string, never>>({
                compare: (meta) => meta.d,
                context: {}
            })
        });
        let worker = mockWorkers[0],
            controller = new AbortController();

        workers({ meta: { d: 5 } }).run(0);                                  // blocker, dispatched now
        workers({ meta: { d: 50 } }).run(50);                                // queued
        let aborted = workers({ meta: { d: 10 }, signal: controller.signal }).run(10);  // queued, then aborted
        workers({ meta: { d: 30 } }).run(30);                                // queued

        controller.abort();

        // Free the worker: the aborted nearest (10) is skipped, so 30 dispatches before 50.
        complete(worker, 0);
        expect(dispatchedId(worker, 1)).toBe(30);

        complete(worker, 1);
        expect(dispatchedId(worker, 2)).toBe(50);

        await expect(aborted).rejects.toThrow(/aborted/);

        complete(worker, 2);
        await workers.shutdown();
    });
});


function task(meta: number): Task {
    return { meta } as unknown as Task;
}

function drain(queue: PriorityQueue): unknown[] {
    let out: unknown[] = [],
        next = queue.next();

    while (next) {
        out.push(next.meta);
        next = queue.next();
    }

    return out;
}


describe('PriorityQueue', () => {
    it('next() on an empty heap returns undefined', () => {
        let queue = new PriorityQueue((m) => m as number, undefined);

        expect(queue.next()).toBeUndefined();
        expect(queue.length).toBe(0);
    });

    it('drains adds in ascending key order across multi-level siftDown', () => {
        let queue = new PriorityQueue((m) => m as number, undefined);

        for (let n of [5, 3, 8, 1, 9, 2, 7]) {
            queue.add(task(n));
        }

        expect(queue.length).toBe(7);
        expect(drain(queue)).toEqual([1, 2, 3, 5, 7, 8, 9]);
        expect(queue.length).toBe(0);
    });

    it('reprioritize re-orders the heap against an inverted context', () => {
        let queue = new PriorityQueue((m, ctx) => Math.abs((m as number) - (ctx as number)), 0);

        for (let n of [10, 20, 30]) {
            queue.add(task(n));
        }

        // ctx=0 -> keys 10,20,30 so the natural drain is ascending (10,20,30).
        // Re-rank against ctx=30 -> keys 20,10,0 inverts the order to (30,20,10).
        queue.reprioritize(30);

        expect(drain(queue)).toEqual([30, 20, 10]);
    });

    it('dequeues every element when keys are equal', () => {
        let queue = new PriorityQueue((m) => m as number, undefined);

        for (let i = 0; i < 3; i++) {
            queue.add(task(5));
        }

        expect(queue.length).toBe(3);
        expect(queue.next()?.meta).toBe(5);
        expect(queue.next()?.meta).toBe(5);
        expect(queue.next()?.meta).toBe(5);
        expect(queue.length).toBe(0);
    });

    it('reprioritize on an empty heap does not throw', () => {
        let queue = new PriorityQueue((m) => m as number, undefined);

        expect(() => queue.reprioritize(1)).not.toThrow();
        expect(queue.length).toBe(0);
    });

    it('length reflects adds and nexts', () => {
        let queue = new PriorityQueue((m) => m as number, undefined);

        expect(queue.length).toBe(0);

        queue.add(task(2));
        queue.add(task(1));
        expect(queue.length).toBe(2);

        queue.next();
        expect(queue.length).toBe(1);

        queue.next();
        expect(queue.length).toBe(0);
    });
});


describe('priority() factory', () => {
    it('returns the compare/context identities tagged with kind priority', () => {
        let compare = (meta: number, ctx: number) => meta - ctx,
            context = { x: 1 };

        let result = priority({ compare, context });

        expect(result.kind).toBe('priority');
        expect(result.compare).toBe(compare);
        expect(result.context).toBe(context);
    });
});
