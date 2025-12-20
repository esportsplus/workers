function collectTransferables(obj: unknown): Transferable[] {
    let result: Transferable[] = [],
        stack = [obj];

    while (stack.length > 0) {
        let current = stack.pop();

        if (!current || typeof current !== 'object') {
            continue;
        }

        if (current instanceof ArrayBuffer ||
            current instanceof MessagePort ||
            (typeof ImageBitmap !== 'undefined' && current instanceof ImageBitmap) ||
            (typeof OffscreenCanvas !== 'undefined' && current instanceof OffscreenCanvas)) {
            result.push(current as Transferable);
            continue;
        }

        if (Array.isArray(current)) {
            for (let i = 0; i < current.length; i++) {
                if (current[i] && typeof current[i] === 'object') {
                    stack.push(current[i]);
                }
            }
        }
        else {
            for (let key in current) {
                let val = (current as Record<string, unknown>)[key];

                if (val && typeof val === 'object') {
                    stack.push(val);
                }
            }
        }
    }

    return result;
}


export { collectTransferables };
