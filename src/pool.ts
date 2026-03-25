import queue from '@esportsplus/queue';
import { collectTransferables } from './transfer';
import { TaskPromise } from './task';
import { InferWithEvents, PoolOptions, PoolStats, ProxyTarget, ScheduleOptions, Task, WorkerLike } from './types';
import { uuid, type UUID } from '@esportsplus/utilities';


const IS_NODE = typeof process !== 'undefined' && process.versions?.node;

const MAX_CONCURRENCY = (
    IS_NODE ? require('os').cpus().length : navigator.hardwareConcurrency
) - 1 || 1;


class NodeWorkerWrapper implements WorkerLike {
    private worker: { on(event: string, handler: (...args: unknown[]) => void): void; postMessage(data: unknown, transfer?: Transferable[]): void; terminate(): void };


    constructor(url: string) {
        this.worker = new (require('worker_threads').Worker)(url);
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

class Pool {
    private available: WorkerLike[] = [];
    private cleanup: (() => void) | null = null;
    private completed = 0;
    private defaultMaxRetryDelay: number;
    private defaultRetries: number;
    private defaultRetryDelay: number;
    private dispatched = 0;
    private failed = 0;
    private heartbeatInterval: number;
    private heartbeatTimeout: number;
    private heartbeatTimers = new Map<WorkerLike, ReturnType<typeof setTimeout>>();
    private idleTimeout: number;
    private idleTimers = new Map<WorkerLike, ReturnType<typeof setTimeout>>();
    private limit: number;
    private maxTasksPerWorker: number;
    private pending = new Map<WorkerLike, Task>();
    private queue: ReturnType<typeof queue<Task>>;
    private retried = 0;
    private tasks = new Map<UUID, Task>();
    private tasksPerWorker = new Map<WorkerLike, number>();
    private timedOut = 0;
    private totalRunTime = 0;
    private totalWaitTime = 0;
    private url: string;
    private workers: WorkerLike[] = [];


    constructor(url: string, options?: PoolOptions) {
        this.defaultMaxRetryDelay = options?.maxRetryDelay ?? 30000;
        this.defaultRetries = options?.retries ?? 0;
        this.defaultRetryDelay = options?.retryDelay ?? 1000;
        this.heartbeatInterval = options?.heartbeatInterval ?? 0;
        this.heartbeatTimeout = options?.heartbeatTimeout ?? 0;
        this.idleTimeout = options?.idleTimeout ?? 0;
        this.limit = options?.limit && options.limit < MAX_CONCURRENCY ? options.limit : MAX_CONCURRENCY;
        this.maxTasksPerWorker = options?.maxTasksPerWorker ?? 0;
        this.queue = queue<Task>(64);
        this.url = url;

        // Only pre-warm workers if idle timeout is disabled
        if (!this.idleTimeout) {
            while (this.workers.length < this.limit) {
                this.available.push(this.createWorker());
            }
        }
    }


    private clearHeartbeatTimer(worker: WorkerLike) {
        clearTimeout(this.heartbeatTimers.get(worker));
        this.heartbeatTimers.delete(worker);
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
                this.clearHeartbeatTimer(worker);
                this.clearTaskTimeout(task);
                this.pending.delete(worker);
                this.tasks.delete(task.uuid);
                task.reject(
                    new Error(e.message ?? '@esportsplus/workers: worker error')
                );
            }

            this.replaceWorker(worker);
            this.processQueue();
        };

        worker.onmessage = (e: { data: unknown }) => {
            let data = e.data as Record<string, unknown>;

            if (!data || !data.uuid) {
                return;
            }

            // Heartbeat response from worker — reset deadline timer
            if (data.heartbeat) {
                this.startHeartbeatTimer(worker);
                return;
            }

            let task = this.tasks.get(data.uuid as UUID);

            if (!task) {
                return;
            }

            // Event dispatch from worker
            if (data.event) {
                task.promise.dispatch(data.event as string, data.data);
                return;
            }

            // Task retained — worker stays bound
            if (data.retained) {
                this.clearHeartbeatTimer(worker);
                this.clearTaskTimeout(task);
                task.retained = true;
                task.worker = worker;
                task.promise.on('release', () => {
                    worker.postMessage({ release: true, uuid: data.uuid });
                });
                return;
            }

            // Task completion
            this.clearHeartbeatTimer(worker);
            this.clearTaskTimeout(task);
            this.pending.delete(worker);
            this.tasks.delete(data.uuid as UUID);

            if (task.startedAt) {
                this.totalRunTime += performance.now() - task.startedAt;
            }

            if (data.error) {
                if (task.attempts < task.maxRetries) {
                    this.retry(task);
                }
                else {
                    let err = data.error as Record<string, unknown>;

                    this.completed++;
                    this.failed++;
                    task.reject(typeof err === 'object'
                        ? Object.assign(new Error(err.message as string), { stack: err.stack })
                        : new Error(String(data.error)));
                }
            }
            else {
                this.completed++;
                task.resolve(data.result);
            }

            // Recycle worker if max tasks reached
            let count = (this.tasksPerWorker.get(worker) ?? 0) + 1;

            if (this.maxTasksPerWorker > 0 && count >= this.maxTasksPerWorker) {
                this.replaceWorker(worker);
                this.available.push(this.createWorker());
            }
            else {
                this.tasksPerWorker.set(worker, count);
                this.markAvailable(worker);
            }

            if (this.cleanup && this.pending.size === 0) {
                this.cleanup();
            }

            this.processQueue();
        };

        this.tasksPerWorker.set(worker, 0);
        this.workers.push(worker);

        return worker;
    }

    private dispatch(worker: WorkerLike, task: Task) {
        if (task.aborted) {
            this.markAvailable(worker);
            this.processQueue();
            return;
        }

        let now = performance.now();

        this.clearIdleTimer(worker);
        this.dispatched++;
        this.pending.set(worker, task);
        this.tasks.set(task.uuid, task);
        this.totalWaitTime += now - task.queuedAt;
        task.startedAt = now;

        // Setup timeout
        if (task.timeout && task.timeout > 0) {
            task.timeoutId = setTimeout(
                () => {
                    if (!this.pending.has(worker)) {
                        return;
                    }

                    this.pending.delete(worker);
                    this.tasks.delete(task.uuid);
                    this.timedOut++;
                    task.reject(new Error(`@esportsplus/workers: task timed out after ${task.timeout}ms`));
                    this.replaceWorker(worker);
                    this.available.push(this.createWorker());
                    this.processQueue();
                },
                task.timeout
            );
        }

        let payload: Record<string, unknown> = { args: task.values, path: task.path, uuid: task.uuid };

        // Start heartbeat monitoring if enabled
        if (this.heartbeatInterval > 0 && this.heartbeatTimeout > 0) {
            payload.heartbeat = true;
            payload.heartbeatInterval = this.heartbeatInterval;
            this.startHeartbeatTimer(worker);
        }

        worker.postMessage(payload, collectTransferables(task.values));
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
        this.clearHeartbeatTimer(worker);
        this.clearIdleTimer(worker);
        this.tasksPerWorker.delete(worker);

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

    private retry(task: Task) {
        task.attempts++;
        this.retried++;

        let delay = Math.min(
            task.retryDelay * Math.pow(2, task.attempts - 1) + Math.random() * task.retryDelay,
            task.maxRetryDelay
        );

        task.aborted = false;
        task.retained = false;
        task.startedAt = undefined;
        task.timeoutId = undefined;
        task.uuid = uuid();
        task.queuedAt = performance.now();

        setTimeout(() => {
            if (task.aborted) {
                task.reject(new Error('@esportsplus/workers: task aborted'));
                return;
            }

            if (this.cleanup) {
                task.reject(new Error('@esportsplus/workers: pool is shutting down'));
                return;
            }

            let worker = this.available.pop();

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
        }, delay);
    }

    private startHeartbeatTimer(worker: WorkerLike) {
        clearTimeout(this.heartbeatTimers.get(worker));

        this.heartbeatTimers.set(
            worker,
            setTimeout(() => {
                let task = this.pending.get(worker);

                this.heartbeatTimers.delete(worker);

                if (!task) {
                    return;
                }

                this.clearTaskTimeout(task);
                this.pending.delete(worker);
                this.tasks.delete(task.uuid);
                this.timedOut++;
                task.reject(new Error(`@esportsplus/workers: worker heartbeat timeout after ${this.heartbeatTimeout}ms`));
                this.replaceWorker(worker);
                this.available.push(this.createWorker());
                this.processQueue();
            }, this.heartbeatTimeout)
        );
    }


    schedule<T, E extends Record<string, unknown>>(
        path: string,
        values: unknown[],
        options?: ScheduleOptions
    ): TaskPromise<T, E> {
        let resolve: (value: T) => void,
            reject: (reason: unknown) => void,
            promise = new TaskPromise<T, E>((res, rej) => {
                resolve = res;
                reject = rej;
            }),
            task: Task = {
                aborted: false,
                attempts: 0,
                maxRetries: options?.retries ?? this.defaultRetries,
                maxRetryDelay: options?.maxRetryDelay ?? this.defaultMaxRetryDelay,
                path,
                promise: promise as TaskPromise<unknown, Record<string, unknown>>,
                queuedAt: performance.now(),
                reject: reject! as (reason: unknown) => void,
                resolve: resolve! as (value: unknown) => void,
                retained: false,
                retryDelay: options?.retryDelay ?? this.defaultRetryDelay,
                signal: options?.signal,
                timeout: options?.timeout,
                uuid: uuid(),
                values
            };

        if (this.cleanup) {
            task.reject(new Error('@esportsplus/workers: pool is shutting down'));
            return promise;
        }

        // Setup abort handler
        if (task.signal) {
            if (task.signal.aborted) {
                task.reject(new Error('@esportsplus/workers: task aborted'));
                return promise;
            }

            task.signal.addEventListener('abort', () => {
                task.aborted = true;

                // If task is pending (running), terminate worker and replace
                for (let [worker, pendingTask] of this.pending) {
                    if (pendingTask === task) {
                        this.clearHeartbeatTimer(worker);
                        this.clearTaskTimeout(task);
                        this.pending.delete(worker);
                        this.tasks.delete(task.uuid);
                        this.replaceWorker(worker);
                        this.available.push(this.createWorker());
                        break;
                    }
                }

                task.reject(new Error('@esportsplus/workers: task aborted'));

                // Eagerly drain aborted tasks from queue head when a worker is idle
                this.processQueue();
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
        // Clear all heartbeat timers
        for (let timer of this.heartbeatTimers.values()) {
            clearTimeout(timer);
        }

        this.heartbeatTimers.clear();

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

        // Release retained tasks
        for (let [worker, task] of this.pending) {
            if (task.retained) {
                worker.postMessage({ release: true, uuid: task.uuid });
            }
        }

        // If no pending tasks, resolve immediately
        if (this.pending.size === 0) {
            this.cleanup = () => {};

            for (let i = 0, n = this.workers.length; i < n; i++) {
                this.workers[i].terminate();
            }

            this.available.length = 0;
            this.tasksPerWorker.clear();
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
                this.tasksPerWorker.clear();
                this.workers.length = 0;
                this.tasks.clear();

                resolve();
            };
        });
    }

    stats(): PoolStats {
        return {
            avgRunTime: this.completed > 0 ? this.totalRunTime / this.completed : 0,
            avgWaitTime: this.dispatched > 0 ? this.totalWaitTime / this.dispatched : 0,
            busy: this.pending.size,
            completed: this.completed,
            failed: this.failed,
            idle: this.available.length,
            queued: this.queue.length,
            retried: this.retried,
            timedOut: this.timedOut,
            workers: this.workers.length
        };
    }
}


export default <T extends Record<string, unknown>, E extends Record<string, Record<string, unknown>> = Record<string, Record<string, unknown>>>(url: string, options?: PoolOptions) => {
    let pool = new Pool(url, options),
        proxy = (options?: ScheduleOptions): InferWithEvents<T, E> => new Proxy(
            Object.assign(() => {}, { options, path: '' }) as ProxyTarget<T>,
            {
                apply: (target: ProxyTarget<T>, _: unknown, values: unknown[]) => {
                    let opts = target.options,
                        path = target.path;

                    target.options = undefined;
                    target.path = '';

                    return pool.schedule(path, values, opts);
                },
                deleteProperty: () => true,
                get: (target: ProxyTarget<T>, key: string, receiver: unknown) => {
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