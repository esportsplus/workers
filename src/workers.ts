import memoize from '@esportsplus/memoize';


class Workers {
    #available: number[] = [];
    #limit: number;
    #url: string;
    #workers: Worker[] = [];


    constructor(url: string, limit?: number) {
        this.#limit = navigator.hardwareConcurrency - 1 || 1;
        this.#url = url;

        if (limit && this.#limit > limit) {
            this.#limit = limit;
        }
    }


    async schedule<T>(path: string[], values: any[]): Promise<T> {
        if (this.#limit > this.#workers.length) {
            let index: number | undefined = this.#available.shift(),
                worker: Worker;

            if (index) {
                worker = this.#workers[index];
            }
            else {
                index = this.#workers.push( worker = new Worker(this.#url) ) - 1;
            }

            return new Promise<T>((resolve, reject) => {
                worker.onmessage = (e) => {
                    this.#available.push( index as number );
                    resolve(e.data);
                };

                worker.onerror = (e) => {
                    this.#available.push( index as number );
                    reject(e.message);
                };

                worker.postMessage([path, values]);
            });
        }

        await Promise.race(this.#workers);

        return this.schedule(path, values);
    }
}


export default memoize((props) => {
    let workers = new Workers(props.url, props.limit);

    return () => new Proxy(
        Object.assign(() => {}, { path: [] }),
        {
            apply: (target: any, __, values: any[]) => {
                Object.freeze(target.path);

                return workers.schedule(target.path, values);
            },
            deleteProperty: () => true,
            get: (target: any, key: string, receiver) => {
                if (key === 'path') {
                    return Reflect.get(target, key);
                }

                target.path.push(key);

                return receiver;
            },
            set: () => true
        }
    );
});