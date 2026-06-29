import { UUID } from '@esportsplus/utilities';
import { TaskPromise } from './task';


interface Actions {
    [key: PropertyKey]: Actions | ((...args: unknown[]) => unknown)
};

type Comparator<Meta, Ctx> = (meta: Meta, ctx: Ctx) => number;

type Infer<T> =
    T extends (...args: infer P) => Promise<infer R>
        ? (...args: P) => Promise<R>
        : T extends (...args: infer P) => infer R
            ? (...args: P) => Promise<R>
            : T extends Record<string, unknown>
                ? { [K in keyof T]: Infer<T[K]> }
                : never;

type InferWithEvents<T, E extends Record<string, Record<string, unknown>>> = {
    [K in keyof T]: T[K] extends (...args: infer A) => Promise<infer R>
        ? (...args: A) => TaskPromise<R, K extends keyof E ? E[K] : Record<string, unknown>>
        : T[K] extends (...args: infer A) => infer R
            ? (...args: A) => TaskPromise<Awaited<R>, K extends keyof E ? E[K] : Record<string, unknown>>
            : T[K] extends Record<string, unknown>
                ? InferWithEvents<T[K], E>
                : never;
};

// Pending-task store the pool dequeues from. The default FIFO queue and the priority min-heap both satisfy
// it, so the pool consumes either through one field.
type PendingStore = {
    add(task: Task): void;
    readonly length: number;
    next(): Task | undefined;
};

type PoolOptions = {
    heartbeatInterval?: number;
    heartbeatTimeout?: number;
    idleTimeout?: number;
    limit?: number;
    maxRetryDelay?: number;
    maxTasksPerWorker?: number;
    retries?: number;
    retryDelay?: number;
    schedule?: PriorityScheduler;
};

type PoolStats = {
    avgRunTime: number;
    avgWaitTime: number;
    busy: number;
    completed: number;
    failed: number;
    idle: number;
    queued: number;
    retried: number;
    timedOut: number;
    workers: number;
};

// Priority-scheduling config (built by `priority(...)`): queued tasks dispatch by ascending
// `compare(meta, context)`; `pool.context(next)` re-ranks them against an updated context.
type PriorityScheduler<Meta = unknown, Ctx = unknown> = {
    compare: Comparator<Meta, Ctx>;
    context: Ctx;
    kind: 'priority';
};

type ProxyTarget<T> = {
    (): T;
    options?: ScheduleOptions;
    path: string;
};

type ScheduleOptions = {
    maxRetryDelay?: number;
    // Opaque per-task key read by a priority scheduler's `compare`. Ignored under FIFO scheduling.
    meta?: unknown;
    retries?: number;
    retryDelay?: number;
    signal?: AbortSignal;
    timeout?: number;
};

type Task = {
    aborted: boolean;
    attempts: number;
    maxRetries: number;
    maxRetryDelay: number;
    meta?: unknown;
    path: string;
    // Cached priority key (compare(meta, context)) while the task sits in a priority queue; unused FIFO.
    priority?: number;
    promise: TaskPromise<unknown, Record<string, unknown>>;
    queuedAt: number;
    reject: (reason: unknown) => void;
    resolve: (value: unknown) => void;
    retained: boolean;
    retryDelay: number;
    signal?: AbortSignal;
    startedAt?: number;
    timeout?: number;
    timeoutId?: ReturnType<typeof setTimeout>;
    uuid: UUID;
    values: unknown[];
    worker?: WorkerLike;
};

type WorkerContext<E extends Record<string, unknown> = Record<string, unknown>> = {
    dispatch: <K extends keyof E>(event: K, data: E[K]) => void;
    release: (result?: unknown) => void;
    retain: (cleanup?: () => void | unknown) => void;
};

type WorkerLike = {
    onerror: (e: { message?: string }) => void;
    onmessage: (e: { data: unknown }) => void;
    postMessage(data: unknown, transfer?: Transferable[]): void;
    terminate(): void;
};

type WorkerPort = {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: (data: unknown, transfer?: Transferable[]) => void;
};


export type {
    Actions,
    Comparator,
    Infer, InferWithEvents,
    PendingStore, PoolOptions, PoolStats, PriorityScheduler, ProxyTarget,
    ScheduleOptions,
    Task,
    WorkerContext, WorkerLike, WorkerPort
};
