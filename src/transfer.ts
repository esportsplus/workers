function collectTransferables(value: unknown): Transferable[] {
    let result: Transferable[] = [],
        stack = [value];

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
                let value = (current as Record<string, unknown>)[key];

                if (value && typeof value === 'object') {
                    stack.push(value);
                }
            }
        }
    }

    return result;
}


export { collectTransferables };
