<script lang="ts" module>
    import {parse} from "devalue";

    export const Action = async (action: string, requestInit: RequestInit = {}, devalue: boolean = true): Promise<{
        url: string,
        protocols: string[] | string,
        open(): WebSocket
    }> => {
        const response = await fetch(action, {
            ...requestInit,
            body: requestInit?.body ? requestInit.body : new FormData(),
            method: 'POST',
        })
        if (!response.ok) {
            throw new Error(`${response.status} ${response.statusText}`, {cause: response})
        }
        const json = await response.json();
        if (devalue === false) {
            return {
                url: json.url,
                protocols: json.protocols ?? [],
                open(): WebSocket {
                    return new WebSocket(json.url, json.protocols ?? [])
                }
            }
        } else {
            const data = parse(json.data);
            return {
                url: data.url,
                protocols: data.protocols ?? [],
                open(): WebSocket {
                    return new WebSocket(data.url, data.protocols ?? [])
                }
            }
        }
    }

    export const ActionSocket = (action: string, requestInit: RequestInit = {}, devalue: boolean = true) => Action(action, requestInit, devalue).then((r) => r.open())

    export class ActionSockerError extends Event {

        public readonly reason: unknown

        constructor(reason: unknown) {
            super("ActionSocketError");
            this.reason = reason;
        }

    }

</script>

<script lang="ts" generics="T = any">

    import {onDestroy, onMount, type Snippet} from "svelte";


    type WebSocketEvents = {
        onmessage?: (ev: MessageEvent<T>) => unknown,
        onopen?: (ev: Event) => unknown,
        onclose?: (ev: CloseEvent) => unknown,
        onerror?: (reason?: Event) => unknown,
    }

    type Snippets = {
        children?: Snippet<[WebSocket]>
        messages?: Snippet<[MessageEvent<T>['data'][], WebSocket]>
        message?: Snippet<[MessageEvent<T>['data'], number, WebSocket]>,
        controller?: Snippet<[typeof ctrl]>
    }

    type Props =
        ({ url: string | URL, protocols?: (string | string[]) } | {
            action: string,
            devalue?: false,
            init?: RequestInit
        }) &
        { auto_open?: boolean, data?: T[], binaryType?: BinaryType } &
        Snippets &
        WebSocketEvents

    let {
        onmessage,
        data = $bindable<MessageEvent<T>['data'][]>([]),
        children,
        messages,
        message,
        auto_open = true,
        ...restProps
    }: Props = $props();

    let ws = $state<WebSocket>();
    let open = $state<boolean>(false);

    const ctrl = {
        async open() {
            if (ws && ws.readyState === WebSocket.OPEN) return;
            let url: string;
            let protocols: (string | string[])
            if ('action' in restProps && restProps.action) {
                try {
                    const result = await Action(restProps.action, restProps.init, restProps.devalue);
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
