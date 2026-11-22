import {parse, stringify} from 'devalue';

/**
 * Turns typed messages into text frames and back. Used on both ends of a connection, so both must use the
 * same codec. `decode` receives untrusted input from the other side: throw to reject a message (a custom
 * codec can validate here, e.g. with a schema library).
 */
export type Codec<T = unknown> = {
    encode(message: T): string;
    decode(data: string): T;
};

/** `'json'` (default), `'devalue'` (also round-trips `Date`, `Map`, `Set`, `BigInt`, cycles, …), or your own. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type CodecOption = 'json' | 'devalue' | Codec<any>;

const checked = (encoded: unknown): string => {
    if (typeof encoded !== 'string') throw new TypeError('Message could not be encoded');
    return encoded;
};

export const jsonCodec: Codec = {
    encode: (message) => checked(JSON.stringify(message)),
    decode: (data) => JSON.parse(data),
};

export const devalueCodec: Codec = {
    encode: (message) => checked(stringify(message)),
    decode: (data) => parse(data),
};

export const resolveCodec = (codec: CodecOption | undefined): Codec => {
    if (codec === undefined || codec === 'json') return jsonCodec;
    if (codec === 'devalue') return devalueCodec;
    return codec;
};
