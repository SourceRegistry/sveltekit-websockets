<script lang="ts" module>
    export {
        Action,
        ActionSocket,
        ActionSocketError,
        defaultShouldReconnect,
        jsonCodec,
        devalueCodec,
        splitConnectionKey,
        KEY_PROTOCOL,
        KEY_PROTOCOL_PREFIX,
        type ActionSocketController,
        type Codec,
        type CodecOption,
        type ReconnectOptions,
        type ActionSocketResult,
        type WebSocketEvents,
        type WebSocketProps,
        type WebSocketSnippets
    } from "./actions.js";
</script>

<script lang="ts" generics="T = any, S = any">

    import {onDestroy, onMount} from "svelte";
    import {
        Action,
        ActionSocketError,
        defaultShouldReconnect,
        type ActionSocketController,
        type ReconnectOptions,
        type WebSocketProps
    } from "./actions.js";
    import {resolveCodec} from "../codec.js";
    import {splitConnectionKey} from "../keys.js";

    let {
        onmessage,
        data = $bindable<MessageEvent<T>['data'][]>([]),
        children,
        messages,
        message,
        auto_open = true,
        max_messages = 1000,
        ...restProps
    }: WebSocketProps<T, S> = $props();

    const codec = () => restProps.codec === undefined ? undefined : resolveCodec(restProps.codec);

    let ws = $state<WebSocket>();
    let open = $state<boolean>(false);
    let reconnecting = $state<boolean>(false);

    // In-flight open(); repeated open() calls share it instead of creating a second socket.
    let opening: Promise<void> | undefined;
    // Bumped by close(): an open() still waiting on its action, or a scheduled reconnect, must not create a
    // socket afterwards.
    let attempt = 0;
    let destroyed = false;
    // Consecutive reconnect attempts since the last successful open.
    let retries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    // Adds a message, dropping the oldest ones beyond `max_messages` so a long-lived socket can't grow `data`
    // without bound.
    const append = (list: typeof data, item: MessageEvent<T>['data']): typeof data => {
        const max = Number.isNaN(max_messages) ? 1000 : Math.max(0, Math.floor(max_messages));
        if (max === 0) return list.length ? [] : list;
        const drop = Math.max(0, list.length + 1 - max);
        return drop ? [...list.slice(drop), item] : [...list, item];
    };

    const reconnectOptions = (): ReconnectOptions | undefined =>
        restProps.reconnect === true ? {} : restProps.reconnect || undefined;

    const cancelReconnect = () => {
        if (retryTimer !== undefined) clearTimeout(retryTimer);
        retryTimer = undefined;
        reconnecting = false;
    };

    // Schedules another attempt after a dropped connection (`ev`) or a failed action request (no `ev`).
    const scheduleReconnect = (current: number, ev?: CloseEvent) => {
        const options = reconnectOptions();
        if (!options || destroyed || current !== attempt || retryTimer !== undefined) return;
        if (ev && !(options.shouldReconnect ?? defaultShouldReconnect)(ev)) return;
        if (retries >= (options.retries ?? Infinity)) return;

        const ceiling = Math.min(
            (options.delay ?? 1000) * (options.factor ?? 2) ** retries,
            options.maxDelay ?? 30_000
        );
        // Between half and all of the ceiling, so many clients don't reconnect in lockstep.
        const delay = ceiling / 2 + Math.random() * (ceiling / 2);
        retries++;
        reconnecting = true;
        retryTimer = setTimeout(() => {
            retryTimer = undefined;
            reconnecting = false;
            if (current === attempt && !destroyed) void start();
        }, delay);
        restProps.onreconnect?.(retries, delay);
    };

    const connect = async (current: number) => {
        let url: string;
        let protocols: (string | string[])
        if ('action' in restProps && restProps.action) {
            try {
                const result = await Action(restProps.action, restProps.init, restProps.devalue ?? true);
                url = result.url;
                protocols = result.protocols
            } catch (e) {
                if (current === attempt) {
                    restProps.onerror?.(new ActionSocketError(e));
                    scheduleReconnect(current);
                }
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

        // The connection key goes in the subprotocols, not the URL, so it stays out of access logs.
        const target = splitConnectionKey(url, protocols);
        const socket = new WebSocket(target.url, target.protocols);
        ws = socket;
        socket.binaryType = restProps.binaryType ? restProps.binaryType : 'arraybuffer';
        socket.onmessage = (raw) => {
            let event: MessageEvent = raw;
            const messageCodec = codec();
            if (messageCodec) {
                try {
                    if (typeof raw.data !== 'string') throw new TypeError('Received a binary frame on a socket with a codec');
                    event = new MessageEvent('message', {
                        data: messageCodec.decode(raw.data),
                        origin: raw.origin,
                        lastEventId: raw.lastEventId
                    });
                } catch (e) {
                    restProps.onerror?.(new ActionSocketError(e));
                    return;
                }
            }
            onmessage?.(event)
            if (ws === socket) data = append(data, event.data);
        }
        socket.onopen = (event) => {
            restProps.onopen?.(event)
            if (ws === socket) {
                open = true;
                retries = 0;
            }
        }
        socket.onclose = (event) => {
            restProps.onclose?.(event)
            if (ws === socket) {
                open = false;
                scheduleReconnect(current, event);
            }
        }
        socket.onerror = (event) => {
            restProps.onerror?.(new ActionSocketError(event));
        }
    }

    const start = (): Promise<void> => {
        if (destroyed) return Promise.resolve();
        if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return Promise.resolve();
        if (!opening) {
            const pending: Promise<void> = connect(attempt).finally(() => {
                if (opening === pending) opening = undefined;
            });
            opening = pending;
        }
        return opening;
    }

    const ctrl: ActionSocketController<S> = {
        open() {
            cancelReconnect();
            return start();
        },
        close(code?: number, reason?: string) {
            attempt++;
            opening = undefined;
            retries = 0;
            cancelReconnect();
            if (!ws) return
            if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return
            ws.close(code, reason)
        },
        send(message: S) {
            if (!ws || ws.readyState !== WebSocket.OPEN) return false;
            const messageCodec = codec();
            ws.send(messageCodec ? messageCodec.encode(message) : message as Parameters<WebSocket['send']>[0]);
            return true;
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
        },
        get reconnecting() {
            return reconnecting;
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
