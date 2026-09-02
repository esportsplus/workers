import { beforeEach, describe, expect, it, vi } from 'vitest';


type MockNodeWorker = {
    _emit: (event: string, ...args: unknown[]) => void;
    on: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
    terminate: ReturnType<typeof vi.fn>;
};

type MockParentPort = {
    _emit: (event: string, ...args: unknown[]) => void;
    on: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
};

const { createMockWorker, mockParentPort, mockWorkers } = vi.hoisted(() => {
    let handlers: Record<string, ((...args: unknown[]) => void)[]> = {},
        mockWorkers: MockNodeWorker[] = [];

    let mockParentPort: MockParentPort = {
        _emit(event: string, ...args: unknown[]) {
            for (let fn of handlers[event] ?? []) {
                fn(...args);
            }
        },
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            (handlers[event] ??= []).push(handler);
        }),
        postMessage: vi.fn()
    };

    function createMockWorker(): MockNodeWorker {
        let workerHandlers: Record<string, ((...args: unknown[]) => void)[]> = {};

        let worker: MockNodeWorker = {
            _emit(event: string, ...args: unknown[]) {
                for (let fn of workerHandlers[event] ?? []) {
                    fn(...args);
                }
            },
            on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
                (workerHandlers[event] ??= []).push(handler);
            }),
            postMessage: vi.fn(),
            terminate: vi.fn()
        };

        mockWorkers.push(worker);
        return worker;
    }

    return { createMockWorker, mockParentPort, mockWorkers };
});

vi.mock('node:worker_threads', () => {
    class MockWorkerClass {
        constructor(_url: string) {
            return createMockWorker() as unknown as MockWorkerClass;
        }
    }

    return { Worker: MockWorkerClass, parentPort: mockParentPort };
});


describe('workerPort', () => {
    let workerPort: typeof import('../src/platform/node').workerPort;

    beforeEach(async () => {
        vi.resetModules();
        workerPort = (await import('../src/platform/node')).workerPort;
    });


    it('returns a non-null port wrapper when parentPort is present', () => {
        let port = workerPort();

        expect(port).not.toBeNull();
    });

    it('onmessage setter registers a message listener that wraps raw data as { data }', () => {
        let port = workerPort()!,
            received: unknown[] = [];

        port.onmessage = (e: MessageEvent) => {
            received.push(e);
        };

        mockParentPort._emit('message', { value: 42 });

        expect(received).toHaveLength(1);
        expect(received[0]).toEqual({ data: { value: 42 } });
    });

    it('postMessage forwards payload and transfer to parentPort.postMessage', () => {
        let port = workerPort()!,
            payload = { task: 'ping' },
            transfer: Transferable[] = [];

        port.postMessage(payload, transfer);

        expect(mockParentPort.postMessage).toHaveBeenCalledWith(payload, transfer);
    });

    it('onmessage handler receives correct data for multiple emissions', () => {
        let port = workerPort()!,
            events: unknown[] = [];

        port.onmessage = (e: MessageEvent) => {
            events.push(e.data);
        };

        mockParentPort._emit('message', 'first');
        mockParentPort._emit('message', 'second');

        expect(events).toEqual(['first', 'second']);
    });
});


describe('NodeWorkerWrapper exit handling (B7)', () => {
    let spawn: typeof import('../src/platform/node').spawn;

    beforeEach(async () => {
        vi.resetModules();
        mockWorkers.length = 0;
        spawn = (await import('../src/platform/node')).spawn;
    });


    it('maps an exit event to onerror carrying the exit code', () => {
        let worker = spawn('test.js'),
            errors: { message?: string }[] = [];

        worker.onerror = (e) => {
            errors.push(e);
        };

        mockWorkers[mockWorkers.length - 1]._emit('exit', 1);

        expect(errors).toHaveLength(1);
        expect(errors[0].message).toContain('worker exited with code 1');
    });

    it('does not map exit to onerror after terminate()', () => {
        let worker = spawn('test.js'),
            errors: { message?: string }[] = [];

        worker.onerror = (e) => {
            errors.push(e);
        };

        worker.terminate();

        mockWorkers[mockWorkers.length - 1]._emit('exit', 0);

        expect(errors).toHaveLength(0);
    });
});
