let objectProto = Object.getPrototypeOf({}) as object;


function hasOnlyPrimitiveValues(obj: Record<string, unknown>): boolean {
    for (let key in obj) {
        let v = obj[key];

        if (v && typeof v === 'object') {
            return false;
        }
    }

    return true;
}

function isAllPrimitive(arr: unknown[]): boolean {
    for (let i = 0, n = arr.length; i < n; i++) {
        let v = arr[i];

        if (v && typeof v === 'object') {
            return false;
        }
    }

    return true;
}

function collectTransferables(value: unknown): Transferable[] {
    // Fast-path: primitives (null, undefined, boolean, number, string, bigint, symbol)
    if (!value || typeof value !== 'object') {
        return [];
    }

    // Fast-path: shallow primitive-only arrays
    if (Array.isArray(value) && isAllPrimitive(value)) {
        return [];
    }

    // Fast-path: shallow primitive-only plain objects
    if (!Array.isArray(value)) {
        let proto = Object.getPrototypeOf(value) as object | null;

        if ((proto === objectProto || proto === null) && hasOnlyPrimitiveValues(value as Record<string, unknown>)) {
            return [];
        }
    }

    let result: Transferable[] = [],
        stack = [value];

    while (stack.length > 0) {
        let current = stack.pop();

        if (!current || typeof current !== 'object') {
            continue;
        }

        if (current instanceof ArrayBuffer ||
            current instanceof MessagePort ||
            (typeof AudioData !== 'undefined' && current instanceof AudioData) ||
            (typeof ImageBitmap !== 'undefined' && current instanceof ImageBitmap) ||
            (typeof MediaSourceHandle !== 'undefined' && current instanceof MediaSourceHandle) ||
            (typeof OffscreenCanvas !== 'undefined' && current instanceof OffscreenCanvas) ||
            (typeof RTCDataChannel !== 'undefined' && current instanceof RTCDataChannel) ||
            (typeof ReadableStream !== 'undefined' && current instanceof ReadableStream) ||
            (typeof TransformStream !== 'undefined' && current instanceof TransformStream) ||
            (typeof VideoFrame !== 'undefined' && current instanceof VideoFrame) ||
            (typeof WritableStream !== 'undefined' && current instanceof WritableStream)) {
            result.push(current as Transferable);
            continue;
        }

        if (Array.isArray(current)) {
            for (let i = 0, n = current.length; i < n; i++) {
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
