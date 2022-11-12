type Infer<T> =
    T extends (...args: any) => any
        ? () => Promise< ReturnType<T> >
        : T extends object
            ? { [K in keyof T]: Infer<T[K]> }
            : () => Promise<T>;


export { Infer };