import { cpus } from 'node:os';
import { Worker, parentPort } from 'node:worker_threads';
import { WorkerLike, WorkerPort } from '../types';


type NodeWorker = {
    on(event: string, handler: (...args: unknown[]) => void): void;
    postMessage(data: unknown, transfer?: Transferable[]): void;
    terminate(): void;
};


class NodeWorkerWrapper implements WorkerLike {
    private worker: NodeWorker;


    constructor(url: string) {
        this.worker = new Worker(url) as unknown as NodeWorker;
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


const cores = (): number => cpus().length;

const spawn = (url: string): WorkerLike => new NodeWorkerWrapper(url);

const workerPort = (): WorkerPort | null => {
    if (!parentPort) {
        return null;
    }

    let port = parentPort as unknown as NodeWorker;

    return {
        set onmessage(fn: (e: MessageEvent) => void) {
            port.on('message', (data: unknown) => {
                fn({ data } as MessageEvent);
            });
        },
        postMessage: (data: unknown, transfer?: Transferable[]) => {
            port.postMessage(data, transfer);
        }
    };
};


export { cores, spawn, workerPort };
