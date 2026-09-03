import { availableParallelism } from 'node:os';
import { Worker, parentPort } from 'node:worker_threads';
import { WorkerLike, WorkerPort } from '../types';


class NodeWorkerWrapper implements WorkerLike {
    private terminated = false;
    private worker: Worker;


    constructor(url: string) {
        // Node's `Worker` accepts a path or a `URL` object but throws on a `file://` STRING — so wrap
        // file URLs (the natural cross-platform worker identifier) in `new URL`; plain paths pass through.
        this.worker = new Worker(url.startsWith('file:') ? new URL(url) : url);
    }


    set onerror(handler: (e: { message?: string }) => void) {
        this.worker.on('error', (err) => {
            handler({ message: (err as Error).message });
        });

        // A worker that exits without an `error` event (process.exit, OS kill, native crash) still
        // strands its pending task; route `exit` through the same handler unless the pool terminated it.
        this.worker.on('exit', (code) => {
            if (this.terminated) {
                return;
            }

            handler({ message: `@esportsplus/workers: worker exited with code ${code}` });
        });
    }

    set onmessage(handler: (e: { data: unknown }) => void) {
        this.worker.on('message', (data) => {
            handler({ data });
        });
    }

    postMessage(data: unknown, transfer?: Transferable[]) {
        this.worker.postMessage(data, transfer as Parameters<Worker['postMessage']>[1]);
    }

    terminate() {
        this.terminated = true;
        void this.worker.terminate();
    }
}


const cores = (): number => availableParallelism();

const spawn = (url: string): WorkerLike => new NodeWorkerWrapper(url);

const workerPort = (): WorkerPort | null => {
    if (!parentPort) {
        return null;
    }

    let port = parentPort;

    return {
        set onmessage(fn: (e: MessageEvent) => void) {
            port.on('message', (data: unknown) => {
                fn({ data } as MessageEvent);
            });
        },
        postMessage: (data: unknown, transfer?: Transferable[]) => {
            port.postMessage(data, transfer as Parameters<typeof port.postMessage>[1]);
        }
    };
};


export { cores, spawn, workerPort };
