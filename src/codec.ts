import { pack, unpack } from 'msgpackr';


const decode = (buffer: ArrayBuffer): any => {
    return unpack(new Uint8Array(buffer));
}

const encode = (data: any): ArrayBuffer => {
    return pack(data).buffer as ArrayBuffer;
}


export { decode, encode };
