import { collectTransferables } from './transfer';
import { Actions, WorkerContext, WorkerPort } from './types';


let cleanups = new Map<string, () => void | unknown>();


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
                    parentPort.on('message', (data: unknown) => {
                        fn({ data } as MessageEvent);
                    });
                },
                postMessage: (data: unknown, transfer?: Transferable[]) => {
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

        if (!data || !data.uuid) {
            return;
        }

        // Handle release request from pool
        if (data.release) {
            let handler = cleanups.get(data.uuid);

            cleanups.delete(data.uuid);

            if (handler) {
                try {
                    let result = handler();

                    worker.postMessage({ result, uuid: data.uuid }, collectTransferables(result));
                }
                catch (err) {
                    let error = err instanceof Error
                        ? { message: err.message, stack: err.stack }
                        : String(err);

                    worker.postMessage({ error, uuid: data.uuid });
                }
            }
            else {
                worker.postMessage({ result: undefined, uuid: data.uuid });
            }

            return;
        }

        if (!data.path) {
            return;
        }

        let { args, path, uuid } = data,
            action = map.get(path);

        if (!action) {
            worker.postMessage({
                error: `@esportsplus/workers: path does not exist '${path}'`,
                uuid,
            });
            return;
        }

        let cleanup: (() => void | unknown) | undefined,
            context: WorkerContext<E> = {
                dispatch: (event, data) => {
                    worker.postMessage({ data, event, uuid }, collectTransferables(data));
                },
                release: (result?) => {
                    if (released) {
                        return;
                    }

                    released = true;
                    cleanups.delete(uuid);
                    worker.postMessage({ result, uuid }, collectTransferables(result));
                },
                retain: (fn?) => {
                    retained = true;
                    cleanup = fn;
                }
            },
            released = false,
            retained = false;

        try {
            let result = await action.call(context, ...args);

            if (retained) {
                if (cleanup) {
                    cleanups.set(uuid, cleanup);
                }

                worker.postMessage({ retained: true, uuid });
            }
            else {
                worker.postMessage({ result, uuid }, collectTransferables(result));
            }
        }
        catch (err) {
            let error = err instanceof Error
                ? { message: err.message, stack: err.stack }
                : String(err);

            worker.postMessage({ error, uuid });
        }
    };
};


export type { Actions };
