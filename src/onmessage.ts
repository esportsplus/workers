import { workerPort } from './platform/node';
import { collectTransferables } from './transfer';
import { Actions, WorkerContext, WorkerPort } from './types';


let cleanups = new Map<string, () => void | unknown>(),
    heartbeats = new Map<string, ReturnType<typeof setInterval>>();


function adapter(): WorkerPort {
    if (typeof self !== 'undefined' && typeof self.postMessage === 'function') {
        return self as unknown as WorkerPort;
    }

    let port = workerPort();

    if (port) {
        return port;
    }

    throw new Error('@esportsplus/workers: must be called from within a worker context');
}

function clearHeartbeat(uuid: string) {
    let id = heartbeats.get(uuid);

    if (id !== undefined) {
        clearInterval(id);
        heartbeats.delete(uuid);
    }
}

function flatten(obj: Actions, prefix: string, map: Map<string, (...args: unknown[]) => unknown>): Map<string, (...args: unknown[]) => unknown> {
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

            clearHeartbeat(data.uuid);
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

        // Start heartbeat interval if pool requested it
        if (data.heartbeat && data.heartbeatInterval) {
            let interval = Math.max(50, Number(data.heartbeatInterval) || 0);

            heartbeats.set(uuid, setInterval(() => {
                worker.postMessage({ heartbeat: true, uuid });
            }, interval));
        }

        if (!action) {
            clearHeartbeat(uuid);
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
                    clearHeartbeat(uuid);
                    worker.postMessage({ result, uuid }, collectTransferables(result));
                },
                retain: (fn?) => {
                    if (released) {
                        return;
                    }

                    retained = true;
                    cleanup = fn;
                }
            },
            released = false,
            retained = false;

        try {
            let result = await action.call(context, ...args);

            if (released) {
                clearHeartbeat(uuid);
                return;
            }

            if (retained) {
                if (cleanup) {
                    cleanups.set(uuid, cleanup);
                }

                worker.postMessage({ retained: true, uuid });
            }
            else {
                clearHeartbeat(uuid);
                worker.postMessage({ result, uuid }, collectTransferables(result));
            }
        }
        catch (err) {
            clearHeartbeat(uuid);

            let error = err instanceof Error
                ? { message: err.message, stack: err.stack }
                : String(err);

            worker.postMessage({ error, uuid });
        }
    };
};


export type { Actions };
