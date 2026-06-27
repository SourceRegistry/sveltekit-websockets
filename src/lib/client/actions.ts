import { parse } from "devalue";
import type { Snippet } from "svelte";

export type ActionSocketResult = {
    url: string,
    protocols: string[] | string,
    open(): WebSocket
}

export type ActionSocketController = {
    open(): Promise<void>,
    close(code?: number, reason?: string): void,
    get websocket(): WebSocket | undefined,
    get isOpen(): boolean,
    get state(): number | undefined
}

export type WebSocketEvents<T = any> = {
    onmessage?: (ev: MessageEvent<T>) => unknown,
    onopen?: (ev: Event) => unknown,
    onclose?: (ev: CloseEvent) => unknown,
    onerror?: (reason?: Event) => unknown,
}

export type WebSocketSnippets<T = any> = {
    children?: Snippet<[WebSocket]>
    messages?: Snippet<[MessageEvent<T>['data'][], WebSocket]>
    message?: Snippet<[MessageEvent<T>['data'], number, WebSocket]>,
    controller?: Snippet<[ActionSocketController]>
}

type ActionResult<Success = Record<string, unknown>> =
    | { type: 'success', data?: Success }
    | { type: 'failure', data?: Record<string, unknown> }
    | { type: 'redirect', location: string }
    | { type: 'error', error: unknown };

export type WebSocketProps<T = any> =
    ({ url: string | URL, protocols?: (string | string[]) } | {
        action: string,
        devalue?: boolean,
        init?: RequestInit
    }) &
    { auto_open?: boolean, data?: T[], binaryType?: BinaryType } &
    WebSocketSnippets<T> &
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
