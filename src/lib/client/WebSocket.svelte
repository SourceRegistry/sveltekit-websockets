<script lang="ts" module>
    export {
        Action,
        ActionSocket,
        ActionSocketError,
        type ActionSocketController,
        type ActionSocketResult,
        type WebSocketEvents,
        type WebSocketProps,
        type WebSocketSnippets
    } from "./actions.js";
</script>

<script lang="ts" generics="T = any">

    import {onDestroy, onMount} from "svelte";
    import {Action, ActionSocketError, type ActionSocketController, type WebSocketProps} from "./actions.js";

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
                    restProps.onerror?.(new ActionSocketError(e));
                    return;
                }
            } else if ('url' in restProps && restProps.url) {
                url = restProps.url instanceof URL ? restProps.url.toString() : restProps.url;
                protocols = restProps.protocols ? restProps.protocols : [];
            } else {
                restProps.onerror?.(new ActionSocketError('url or action is required'));
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
                restProps.onerror?.(new ActionSocketError(event));
            }
        },
        close(code?: number, reason?: string) {
            if (!ws) return
            if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return
            ws.close(code, reason)
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
