import queue from '@esportsplus/queue';
import { collectTransferables } from './transfer';
import { TaskPromise } from './task';
import { InferWithEvents, PoolOptions, PoolStats, ProxyTarget, ScheduleOptions, Task, WorkerLike } from './types';


const IS_NODE = typeof process !== 'undefined' && process.versions?.node;

const MAX_CONCURRENCY = (
    IS_NODE ? require('os').cpus().length : navigator.hardwareConcurrency
) - 1 || 1;


class NodeWorkerWrapper implements WorkerLike {
    private worker: any;


    constructor(url: string) {
        this.worker = new (require('worker_threads').Worker)(url);
    }


    set onerror(handler: (e: any) => void) {
        this.worker.on('error', (err: Error) => {
            handler({ message: err.message });
        });
    }

    set onmessage(handler: (e: any) => void) {
        this.worker.on('message', (data: any) => {
            handler({ data });
        });
    }

    postMessage(data: any, transfer?: Transferable[]) {
        this.worker.postMessage(data, transfer);
    }

    terminate() {
        this.worker.terminate();
    }
}

class Pool {
    private available: WorkerLike[] = [];
    private cleanup: (() => void) | null = null;
    private completed = 0;
    private idleTimeout: number;
    private idleTimers = new Map<WorkerLike, ReturnType<typeof setTimeout>>();
    private limit: number;
    private nextTaskId = 1;
    private pending = new Map<WorkerLike, Task>();
    private queue: ReturnType<typeof queue<Task>>;
    private tasks = new Map<number, Task>();
    private url: string;
    private workers: WorkerLike[] = [];


    constructor(url: string, options?: PoolOptions) {
        this.idleTimeout = options?.idleTimeout ?? 0;
        this.limit = options?.limit && options.limit < MAX_CONCURRENCY ? options.limit : MAX_CONCURRENCY;
        this.queue = queue<Task>(64);
        this.url = url;

        // Only pre-warm workers if idle timeout is disabled
        if (!this.idleTimeout) {
            while (this.workers.length < this.limit) {
                this.available.push(this.createWorker());
            }
        }
    }


    private clearIdleTimer(worker: WorkerLike) {
        clearTimeout(this.idleTimers.get(worker));
        this.idleTimers.delete(worker);
    }

    private clearTaskTimeout(task: Task) {
        clearTimeout(task.timeoutId);
        task.timeoutId = undefined;
    }

    private createWorker(): WorkerLike {
        let worker = IS_NODE
            ? new NodeWorkerWrapper(this.url)
            : new Worker(this.url, { type: 'module' }) as unknown as WorkerLike;

        worker.onerror = (e) => {
            let task = this.pending.get(worker);

            if (task) {
                this.clearTaskTimeout(task);
                this.pending.delete(worker);
                this.tasks.delete(task.id);
                task.reject(e.message);
            }

            this.replaceWorker(worker);
            this.processQueue();
        };

        worker.onmessage = (e) => {
            let data = e.data;

            if (!data || typeof data.id !== 'number') {
                return;
            }

            let task = this.tasks.get(data.id);

            if (!task) {
                return;
            }

            // Event dispatch from worker
            if (data.event) {
                task.promise.dispatch(data.event, data.data);
                return;
            }

            // Task completion
            this.clearTaskTimeout(task);
            this.pending.delete(worker);
            this.tasks.delete(data.id);
            this.completed++;

            if (data.error) {
                task.reject(typeof data.error === 'object'
                    ? Object.assign(new Error(data.error.message), { stack: data.error.stack })
                    : new Error(data.error));
            }
            else {
                task.resolve(data.result);
            }

            this.markAvailable(worker);

            if (this.cleanup && this.pending.size === 0) {
                this.cleanup();
            }

            this.processQueue();
        };

        this.workers.push(worker);

        return worker;
    }

    private dispatch(worker: WorkerLike, task: Task) {
        if (task.aborted) {
            this.markAvailable(worker);
            this.processQueue();
            return;
        }

        this.clearIdleTimer(worker);
        this.pending.set(worker, task);
        this.tasks.set(task.id, task);

        // Setup timeout
        if (task.timeout && task.timeout > 0) {
            task.timeoutId = setTimeout(
                () => {
                    if (this.pending.has(worker)) {
                        this.pending.delete(worker);
                        this.tasks.delete(task.id);
                        task.reject(new Error(`@esportsplus/workers: task timed out after ${task.timeout}ms`));
                        this.replaceWorker(worker);
                        this.available.push(this.createWorker());
                        this.processQueue();
                    }
                },
                task.timeout
            );
        }

        worker.postMessage({ id: task.id, path: task.path, args: task.values }, collectTransferables(task.values));
    }

    private processQueue() {
        if (this.cleanup || this.available.length === 0 || this.queue.length === 0) {
            return;
        }

        let task = this.queue.next(),
            worker = this.available.pop()!;

        // Skip aborted tasks
        while (task && task.aborted) {
            task = this.queue.next();
        }

        if (!task) {
            this.available.push(worker);
            return;
        }

        this.dispatch(worker, task);
    }

    private markAvailable(worker: WorkerLike) {
        this.available.push(worker);

        if (!this.idleTimeout) {
            return;
        }

        this.idleTimers.set(
            worker,
            setTimeout(() => {
                this.idleTimers.delete(worker);
                this.replaceWorker(worker);
            }, this.idleTimeout)
        );
    }

    private replaceWorker(worker: WorkerLike) {
        this.clearIdleTimer(worker);

        let index = this.workers.indexOf(worker);

        if (index !== -1) {
            this.workers.splice(index, 1);
        }

        index = this.available.indexOf(worker);

        if (index !== -1) {
            this.available.splice(index, 1);
        }

        worker.terminate();
    }


    schedule<T, E extends Record<string, unknown>>(
        path: string,
        values: any[],
        options?: ScheduleOptions
    ): TaskPromise<T, E> {
        let promise = new TaskPromise<T, E>((res, rej) => {
                resolve = res;
                reject = rej;
            }),
            reject!: (reason: any) => void,
            resolve!: (value: T) => void,
            taskId = this.nextTaskId++;

        if (this.cleanup) {
            reject(new Error('@esportsplus/workers: pool is shutting down'));
            return promise;
        }

        let task: Task = {
                aborted: false,
                id: taskId,
                path,
                promise,
                reject,
                resolve,
                signal: options?.signal,
                timeout: options?.timeout,
                values
            };

        // Setup abort handler
        if (task.signal) {
            if (task.signal.aborted) {
                reject(new Error('@esportsplus/workers: task aborted'));
                return promise;
            }

            task.signal.addEventListener('abort', () => {
                task.aborted = true;

                // If task is pending (running), terminate worker and replace
                for (let [worker, pendingTask] of this.pending) {
                    if (pendingTask === task) {
                        this.clearTaskTimeout(task);
                        this.pending.delete(worker);
                        this.tasks.delete(task.id);
                        this.replaceWorker(worker);
                        this.available.push(this.createWorker());
                        this.processQueue();
                        break;
                    }
                }

                reject(new Error('@esportsplus/workers: task aborted'));
            }, { once: true });
        }

        let worker = this.available.pop();

        // Recreate worker if all were terminated due to idle timeout
        if (!worker && this.workers.length < this.limit) {
            worker = this.createWorker();
        }

        if (worker) {
            this.clearIdleTimer(worker);
            this.dispatch(worker, task);
        }
        else {
            this.queue.add(task);
        }

        return promise;
    }

    shutdown(): Promise<void> {
        // Clear all idle timers
        for (let timer of this.idleTimers.values()) {
            clearTimeout(timer);
        }

        this.idleTimers.clear();

        // Reject all queued tasks
        let task = this.queue.next();

        while (task) {
            task.reject(new Error('@esportsplus/workers: pool closing'));
            task = this.queue.next();
        }

        // If no pending tasks, resolve immediately
        if (this.pending.size === 0) {
            this.cleanup = () => {};

            for (let i = 0, n = this.workers.length; i < n; i++) {
                this.workers[i].terminate();
            }

            this.available.length = 0;
            this.workers.length = 0;
            this.tasks.clear();

            return Promise.resolve();
        }

        // Wait for pending tasks to complete
        return new Promise((resolve) => {
            this.cleanup = () => {
                for (let i = 0, n = this.workers.length; i < n; i++) {
                    this.workers[i].terminate();
                }

                this.available.length = 0;
                this.workers.length = 0;
                this.tasks.clear();

                resolve();
            };
        });
    }

    stats(): PoolStats {
        return {
            busy: this.pending.size,
            completed: this.completed,
            idle: this.available.length,
            queued: this.queue.length,
            workers: this.workers.length
        };
    }
}


export default <T extends Record<string, any>, E extends Record<string, any> = Record<string, any>>(url: string, options?: PoolOptions) => {
    let pool = new Pool(url, options),
        proxy = (options?: ScheduleOptions): InferWithEvents<T, E> => new Proxy(
            Object.assign(() => {}, { options, path: '' }) as ProxyTarget<T>,
            {
                apply: (target: ProxyTarget<T>, __: any, values: any[]) => {
                    let opts = target.options,
                        path = target.path;

                    target.options = undefined;
                    target.path = '';

                    return pool.schedule(path, values, opts);
                },
                deleteProperty: () => true,
                get: (target: ProxyTarget<T>, key: string, receiver: any) => {
                    if (key === 'options' || key === 'path') {
                        return Reflect.get(target, key);
                    }

                    target.path = target.path ? `${target.path}.${key}` : key;

                    return receiver;
                },
                set: () => true
            }
        ) as unknown as InferWithEvents<T, E>;

    return Object.assign(proxy, {
        shutdown: () => pool.shutdown(),
        stats: () => pool.stats()
    });
};