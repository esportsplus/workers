type Infer<T> =
    T extends (...args: any[]) => Promise<any>
        ? T
        : T extends (...args: any[]) => any
            ? () => Promise< ReturnType<T> >
            : T extends Record<string, any>
                ? { [K in keyof T]: Infer<T[K]> }
                : never;


export { Infer };