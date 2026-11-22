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

    // In-flight open(); repeated open() calls share it instead of creating a second socket.
    let opening: Promise<void> | undefined;
    // Bumped by close(): an open() still waiting on its action must not create a socket afterwards.
    let attempt = 0;
    let destroyed = false;

    const connect = async (current: number) => {
        let url: string;
        let protocols: (string | string[])
        if ('action' in restProps && restProps.action) {
            try {
                const result = await Action(restProps.action, restProps.init, restProps.devalue ?? true);
                url = result.url;
                protocols = result.protocols
            } catch (e) {
                if (current === attempt) restProps.onerror?.(new ActionSocketError(e));
                return;
            }
        } else if ('url' in restProps && restProps.url) {
            url = restProps.url instanceof URL ? restProps.url.toString() : restProps.url;
            protocols = restProps.protocols ? restProps.protocols : [];
        } else {
            restProps.onerror?.(new ActionSocketError('url or action is required'));
            return;
        }

        // close() ran or the component unmounted while the action was in flight.
        if (current !== attempt || destroyed) return;

        const socket = new WebSocket(url, protocols);
        ws = socket;
        socket.binaryType = restProps.binaryType ? restProps.binaryType : 'arraybuffer';
        socket.onmessage = (event) => {
            onmessage?.(event)
            if (ws === socket) data = [...data, event.data];
        }
        socket.onopen = (event) => {
            restProps.onopen?.(event)
            if (ws === socket) open = true;
        }
        socket.onclose = (event) => {
            restProps.onclose?.(event)
            if (ws === socket) open = false;
        }
        socket.onerror = (event) => {
            restProps.onerror?.(new ActionSocketError(event));
        }
    }

    const ctrl: ActionSocketController = {
        open() {
            if (destroyed) return Promise.resolve();
            if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return Promise.resolve();
            if (!opening) {
                const pending: Promise<void> = connect(attempt).finally(() => {
                    if (opening === pending) opening = undefined;
                });
                opening = pending;
            }
            return opening;
        },
        close(code?: number, reason?: string) {
            attempt++;
            opening = undefined;
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

    onDestroy(() => {
        destroyed = true;
        ctrl.close();
    });

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
