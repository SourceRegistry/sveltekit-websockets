<script lang="ts" module>
    import {parse} from "devalue";
    import type {Snippet} from "svelte";

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
            throw new Error(`${response.status} ${response.statusText}`, {cause: response})
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
                throw new Error(`Action failed with result type "${result.type}"`, {cause: result});
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

    export class ActionSockerError extends Event {

        public readonly reason: unknown

        constructor(reason: unknown) {
            super("ActionSocketError");
            this.reason = reason;
        }

    }

</script>

<script lang="ts" generics="T = any">

    import {onDestroy, onMount} from "svelte";

    let {
        onmessage,
        data = $bindable<MessageEvent<T>['data'][]>([]),
        children,
        messages,
        message,
        auto_open = true,
        ...restProps
    }: WebSocketProps<T> = $props();

    let ws = $state<WebSocket>();
    let open = $state<boolean>(false);

    const ctrl: ActionSocketController = {
        async open() {
            if (ws && ws.readyState === WebSocket.OPEN) return;
            let url: string;
            let protocols: (string | string[])
            if ('action' in restProps && restProps.action) {
                try {
                    const result = await Action(restProps.action, restProps.init, restProps.devalue ?? true);
                    url = result.url;
                    protocols = result.protocols
                } catch (e) {
                    restProps.onerror?.(new ActionSockerError('url or action is required'));
                    return;
                }
            } else if ('url' in restProps && restProps.url) {
                url = restProps.url instanceof URL ? restProps.url.toString() : restProps.url;
                protocols = restProps.protocols ? restProps.protocols : [];
            } else {
                restProps.onerror?.(new ActionSockerError('url or action is required'));
                return;
            }

            ws = new WebSocket(url, protocols);
            ws.binaryType = restProps.binaryType ? restProps.binaryType : 'arraybuffer';
            ws.onmessage = (event) => {
                onmessage?.(event)
                data = [...data, event.data];
            }
            ws.onopen = (event) => {
                restProps.onopen?.(event)
                open = true;
            }
            ws.onclose = (event) => {
                restProps.onclose?.(event)
                open = false;
            }
            ws.onerror = (event) => {
                restProps.onerror?.(new ActionSockerError(event));
            }
        },
        close(code?: number, reason?: string) {
            if (!ws) return
            if (ws.readyState === WebSocket.OPEN) return ws.close(code, reason)
        },
        get websocket() {
            return ws;
        },
        get isOpen() {
            return open;
        },
        get state() {
            if (!ws) return
            return ws.readyState;
        }
    }

    onMount(async () => {
        if (auto_open) await ctrl.open();
    })

    onDestroy(() => ctrl.close());

</script>

{#if ws && open}
    {@render children?.(ws)}
    {@render messages?.(data, ws)}
    {#if message }
        {#each data as d, i}
            {@render message?.(d, i, ws)}
        {/each}
    {/if}
{/if}

{@render restProps.controller?.(ctrl)}
