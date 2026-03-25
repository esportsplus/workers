import { UUID } from '@esportsplus/utilities';
import { TaskPromise } from './task';


interface Actions {
    [key: PropertyKey]: Actions | ((...args: unknown[]) => unknown)
};

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

type PoolOptions = {
    heartbeatInterval?: number;
    heartbeatTimeout?: number;
    idleTimeout?: number;
    limit?: number;
    maxRetryDelay?: number;
    maxTasksPerWorker?: number;
    retries?: number;
    retryDelay?: number;
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

type ProxyTarget<T> = {
    (): T;
    options?: ScheduleOptions;
    path: string;
};

type ScheduleOptions = {
    maxRetryDelay?: number;
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
    path: string;
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
    Infer, InferWithEvents,
    PoolOptions, PoolStats, ProxyTarget,
    ScheduleOptions,
    Task,
    WorkerContext, WorkerLike, WorkerPort
};