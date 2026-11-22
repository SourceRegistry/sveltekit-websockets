import { parse } from "devalue";
import type { Snippet } from "svelte";
import type { CodecOption } from "../codec.js";

export { jsonCodec, devalueCodec, type Codec, type CodecOption } from "../codec.js";

export type ActionSocketResult = {
    url: string,
    protocols: string[] | string,
    open(): WebSocket
}

/** @typeParam S - messages sent with {@link ActionSocketController.send} */
export type ActionSocketController<S = any> = {
    /** Connects (re-running the action, if any). Cancels a scheduled reconnect. */
    open(): Promise<void>,
    /** Closes the socket and cancels any pending connect or scheduled reconnect. */
    close(code?: number, reason?: string): void,
    /**
     * Sends a message: encoded with `codec` when one is set, otherwise passed to `WebSocket.send` as is.
     * Returns `false` (and sends nothing) when the socket isn't open.
     */
    send(message: S): boolean,
    get websocket(): WebSocket | undefined,
    get isOpen(): boolean,
    get state(): number | undefined,
    /** `true` while a reconnect is scheduled. */
    get reconnecting(): boolean
}

/**
 * Automatic reconnection after the connection drops or the action request fails. The wait before attempt
 * `n` (1-based) is `min(delay * factor^(n-1), maxDelay)`, randomized to between half and all of that so
 * many clients don't reconnect in lockstep. The attempt count resets once a connection opens.
 * Action-based sockets re-run the action on every attempt, so each gets a fresh connection key.
 */
export type ReconnectOptions = {
    /** Maximum consecutive attempts. Default: unlimited. */
    retries?: number,
    /** Base delay in ms. Default `1000`. */
    delay?: number,
    /** Upper bound for the delay in ms. Default `30000`. */
    maxDelay?: number,
    /** Backoff multiplier. Default `2`. */
    factor?: number,
    /**
     * Whether to reconnect after this close. Default: reconnect unless the server closed normally (`1000`,
     * `1005`) or for a policy violation (`1008`: failed auth, invalid key, missing parameter), which a retry
     * wouldn't fix. Never called after `close()` or unmount, which don't reconnect.
     */
    shouldReconnect?: (ev: CloseEvent) => boolean,
}

export const defaultShouldReconnect = (ev: CloseEvent): boolean =>
    ev.code !== 1000 && ev.code !== 1005 && ev.code !== 1008;

export type WebSocketEvents<T = any> = {
    onmessage?: (ev: MessageEvent<T>) => unknown,
    onopen?: (ev: Event) => unknown,
    onclose?: (ev: CloseEvent) => unknown,
    onerror?: (reason?: Event) => unknown,
    /** A reconnect was scheduled: `attempt` is 1-based, `delay` in ms. */
    onreconnect?: (attempt: number, delay: number) => unknown,
}

export type WebSocketSnippets<T = any, S = any> = {
    children?: Snippet<[WebSocket]>
    messages?: Snippet<[MessageEvent<T>['data'][], WebSocket]>
    message?: Snippet<[MessageEvent<T>['data'], number, WebSocket]>,
    controller?: Snippet<[ActionSocketController<S>]>
}

type ActionResult<Success = Record<string, unknown>> =
    | { type: 'success', data?: Success }
    | { type: 'failure', data?: Record<string, unknown> }
    | { type: 'redirect', location: string }
    | { type: 'error', error: unknown };

/**
 * @typeParam T - messages received (decoded with `codec` when set)
 * @typeParam S - messages sent with `ctrl.send`
 */
export type WebSocketProps<T = any, S = any> =
    ({ url: string | URL, protocols?: (string | string[]) } | {
        action: string,
        devalue?: boolean,
        init?: RequestInit
    }) &
    {
        auto_open?: boolean,
        data?: T[],
        /**
         * Most messages kept in `data`; older ones are dropped first. Default `1000`. `Infinity` keeps
         * everything, `0` keeps nothing (use `onmessage`).
         */
        max_messages?: number,
        binaryType?: BinaryType,
        /**
         * Decode received messages (and encode `ctrl.send`) with this codec; must match the server's
         * `codec`. `data`, the snippets and `onmessage` then get decoded messages. A message that can't be
         * decoded is skipped and reported through `onerror`. Default: none (raw `event.data`).
         */
        codec?: CodecOption,
        /** Reconnect automatically; `true` uses the defaults of {@link ReconnectOptions}. Default `false`. */
        reconnect?: boolean | ReconnectOptions
    } &
    WebSocketSnippets<T, S> &
    WebSocketEvents<T>

/**
 * Gives the ability to call the action and create the connection url but not use it directly
 * @param action
 * @param requestInit
 * @param devalue
 * @constructor
 */
export const Action = async (action: string, requestInit: RequestInit = {}, devalue: boolean = true): Promise<ActionSocketResult> => {
    const headers = new Headers(requestInit.headers);
    if (devalue !== false) {
        headers.set('accept', 'application/json');
        headers.set('x-sveltekit-action', 'true');
    }

    const response = await fetch(action, {
        ...requestInit,
        headers,
        body: requestInit.body ?? new FormData(),
        method: 'POST',
        cache: requestInit.cache ?? 'no-store',
    });

    if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`, { cause: response })
    }

    if (devalue === false) {
        const json = await response.json();
        return {
            url: json.url,
            protocols: json.protocols ?? [],
            open(): WebSocket {
                return new WebSocket(json.url, json.protocols ?? [])
            }
        }
    } else {
        const result = deserializeActionResult<{ url: string, protocols?: string | string[] }>(await response.text());
        if (result.type !== 'success' || !result.data?.url) {
            throw new Error(`Action failed with result type "${result.type}"`, { cause: result });
        }

        const data = result.data;
        return {
            url: data.url,
            protocols: data.protocols ?? [],
            open(): WebSocket {
                return new WebSocket(data.url, data.protocols ?? [])
            }
        }
    }
}

const deserializeActionResult = <Success,>(body: string): ActionResult<Success> => {
    const result = JSON.parse(body);
    if (result.data) result.data = parse(result.data);
    return result;
}

/**
 * Used to create a WebSocket based on a form action
 * @param action
 * @param requestInit
 * @param devalue
 * @constructor
 */
export const ActionSocket = (action: string, requestInit: RequestInit = {}, devalue: boolean = true): Promise<WebSocket> => Action(action, requestInit, devalue).then((r) => r.open())

export class ActionSocketError extends Event {

    public readonly reason: unknown

    constructor(reason: unknown) {
        super("ActionSocketError");
        this.reason = reason;
    }

}
