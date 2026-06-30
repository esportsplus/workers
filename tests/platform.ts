import { beforeEach, describe, expect, it, vi } from 'vitest';


type MockParentPort = {
    _emit: (event: string, ...args: unknown[]) => void;
    on: ReturnType<typeof vi.fn>;
    postMessage: ReturnType<typeof vi.fn>;
};

const { mockParentPort } = vi.hoisted(() => {
    let handlers: Record<string, ((...args: unknown[]) => void)[]> = {};

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

    return { mockParentPort };
});

vi.mock('node:worker_threads', () => {
    class MockWorkerClass {
        constructor(_url: string) {
            return {} as unknown as MockWorkerClass;
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
