interface Actions {
    [key: PropertyKey]: Actions | (<T>(...args: unknown[]) => T)
};

type Infer<T> =
    T extends (...args: infer P) => Promise<infer R>
        ? (...args: P) => Promise<R>
        : T extends (...args: infer P) => infer R
            ? (...args: P) => Promise<R>
            : T extends Record<string, any>
                ? { [K in keyof T]: Infer<T[K]> }
                : never;

type PoolOptions = {
    idleTimeout?: number;
    limit?: number;
    maxQueue?: number;
};

type PoolStats = {
    busy: number;
    completed: number;
    idle: number;
    queued: number;
    workers: number;
};

type WorkerContext<E extends Record<string, any> = Record<string, any>> = {
    dispatch: <K extends keyof E>(event: K, data: E[K]) => void;
};

type ProxyTarget<T> = {
    (): T;
    options?: ScheduleOptions;
    path: string;
};

type ScheduleOptions = {
    signal?: AbortSignal;
    timeout?: number;
};

type Task = {
    aborted: boolean;
    path: string;
    reject: (reason: any) => void;
    resolve: (value: any) => void;
    signal?: AbortSignal;
    timeout?: number;
    timeoutId?: ReturnType<typeof setTimeout>;
    values: any[];
};

type WorkerLike = {
    onerror: (e: any) => void;
    onmessage: (e: any) => void;
    postMessage(data: any, transfer?: Transferable[]): void;
    terminate(): void;
};

type WorkerPort = {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: (data: any, transfer?: Transferable[]) => void;
};


export type {
    Actions,
    Infer,
    PoolOptions, PoolStats, ProxyTarget,
    ScheduleOptions,
    Task,
    WorkerContext, WorkerLike, WorkerPort
};