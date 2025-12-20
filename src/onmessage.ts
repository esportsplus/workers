import { collectTransferables } from './transfer';
import { Actions, WorkerContext, WorkerPort } from './types';


function adapter(): WorkerPort {
    // Browser Web Worker
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
        return self as unknown as WorkerPort;
    }

    // Node.js worker_threads
    try {
        let { parentPort } = require('worker_threads');

        if (parentPort) {
            return {
                set onmessage(fn: (e: MessageEvent) => void) {
                    parentPort.on('message', (data: any) => {
                        fn({ data } as MessageEvent);
                    });
                },
                postMessage: (data: any, transfer?: Transferable[]) => {
                    parentPort.postMessage(data, transfer);
                }
            };
        }
    }
    catch {
        // Not in Node.js or worker_threads not available
    }

    throw new Error('@esportsplus/workers: must be called from within a worker context');
}

function flatten(obj: Actions, prefix: string, map: Map<string, Function>): Map<string, Function> {
    for (let key in obj) {
        let path = prefix ? `${prefix}.${key}` : key,
            value = obj[key];

        if (!value) {
            continue;
        }

        if (typeof value === 'function') {
            map.set(path, value);
        }
        else if (typeof value === 'object') {
            flatten(value as Actions, path, map);
        }
    }

    return map;
}


export default <E extends Record<string, unknown> = Record<string, unknown>>(actions: Actions) => {
    let map = flatten(actions, '', new Map()),
        worker = adapter();

    worker.onmessage = async (e) => {
        let data = e.data;

        if (!data || typeof data.id !== 'number' || !data.path) {
            return;
        }

        let { id, path, args } = data,
            action = map.get(path);

        if (!action) {
            worker.postMessage({
                id,
                error: `@esportsplus/workers: path does not exist '${path}'`
            });
            return;
        }

        let context: WorkerContext<E> = {
                dispatch: (event, eventData) => {
                    worker.postMessage({ id, event, data: eventData }, collectTransferables(eventData));
                }
            };

        try {
            let result = await action.call(context, ...args);

            worker.postMessage({ id, result }, collectTransferables(result));
        }
        catch (err) {
            let error = err instanceof Error
                ? { message: err.message, stack: err.stack }
                : String(err);

            worker.postMessage({ id, error });
        }
    };
};


export type { Actions };