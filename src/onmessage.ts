import { decode, encode } from './codec';
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


export default <E extends Record<string, any> = Record<string, any>>(actions: Actions) => {
    let context: WorkerContext<E> = {
            dispatch: (event, data) => {
                let buffer = encode({ __event: event, __data: data });

                worker.postMessage(buffer, [buffer]);
            }
        },
        map = flatten(actions, '', new Map()),
        worker = adapter();

    worker.onmessage = async (e) => {
        let data = e.data;

        if (data instanceof ArrayBuffer) {
            data = decode(data);
        }

        if (!data?.action) {
            return;
        }

        let [path, values] = data.action,
            action = map.get(path);

        if (!action) {
            throw new Error(`@esportsplus/workers: path does not exist '${path}'`);
        }

        let buffer = encode( await action(...values, context) );

        worker.postMessage(buffer, [buffer]);
    };
};
export type { Actions };