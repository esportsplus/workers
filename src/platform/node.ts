import { createRequire } from 'node:module';
import { WorkerLike, WorkerPort } from '../types';


const nodeRequire = createRequire(import.meta.url);


type NodeWorker = {
    on(event: string, handler: (...args: unknown[]) => void): void;
    postMessage(data: unknown, transfer?: Transferable[]): void;
    terminate(): void;
};


class NodeWorkerWrapper implements WorkerLike {
    private worker: NodeWorker;


    constructor(url: string) {
        this.worker = new (nodeRequire('worker_threads').Worker)(url);
    }


    set onerror(handler: (e: { message?: string }) => void) {
        this.worker.on('error', (err) => {
            handler({ message: (err as Error).message });
        });
    }

    set onmessage(handler: (e: { data: unknown }) => void) {
        this.worker.on('message', (data) => {
            handler({ data });
        });
    }

    postMessage(data: unknown, transfer?: Transferable[]) {
        this.worker.postMessage(data, transfer);
    }

    terminate() {
        this.worker.terminate();
    }
}


const cores = (): number => nodeRequire('os').cpus().length;

const spawn = (url: string): WorkerLike => new NodeWorkerWrapper(url);

const workerPort = (): WorkerPort | null => {
    let parentPort = nodeRequire('worker_threads').parentPort;

    if (!parentPort) {
        return null;
    }

    return {
        set onmessage(fn: (e: MessageEvent) => void) {
            parentPort.on('message', (data: unknown) => {
                fn({ data } as MessageEvent);
            });
        },
        postMessage: (data: unknown, transfer?: Transferable[]) => {
            parentPort.postMessage(data, transfer);
        }
    };
};


export { cores, spawn, workerPort };
