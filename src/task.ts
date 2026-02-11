class TaskPromise<T, E extends Record<string, unknown> = Record<string, unknown>> extends Promise<T> {
    private listeners: Record<string, ((data: unknown) => void)[]> | null = null;


    static get [Symbol.species]() {
        return Promise;
    }


    dispatch(event: 'release' | string, data?: unknown): void {
        let handlers = this.listeners?.[event];

        if (!handlers) {
            return;
        }

        for (let i = 0, n = handlers.length; i < n; i++) {
            handlers[i](data);
        }
    }

    on<K extends keyof E>(event: K, handler: (data: E[K]) => void): this {
        ((this.listeners ??= {})[event as string] ??= []).push(
            handler as (data: unknown) => void
        );

        return this;
    }
}


export { TaskPromise };
