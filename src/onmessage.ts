interface Actions {
    [key: PropertyKey]: Actions | (<T>(...args: unknown[]) => T)
};


export default (actions: Actions, worker: Worker) => {
    worker.onmessage = async (e) => {
        if (!Array.isArray( e?.data?.action )) {
            return;
        }

        let [path, values] = e.data?.action,
            action: any = actions;

        for (let i = 0, n = path.length; i < n; i++) {
            action = action[path[i]];

            if (!action) {
                break;
            }
        }

        if (typeof action !== 'function') {
            throw new Error(`Path does not exist '${path}'`);
        }

        worker.postMessage( await action(...values) );
    };
};
export type { Actions };