import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'vitest-browser-svelte';
import {createRawSnippet} from 'svelte';
import {parse, stringify} from 'devalue';
import WebSocketComponent from './WebSocket.svelte';
import type {ActionSocketController} from './actions.js';

class FakeWebSocket {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    static instances: FakeWebSocket[] = [];

    readyState = FakeWebSocket.CONNECTING;
    binaryType = 'blob';
    onopen: ((ev: Event) => void) | null = null;
    onclose: ((ev: CloseEvent) => void) | null = null;
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: Event) => void) | null = null;

    constructor(public url: string, public protocols?: string | string[]) {
        FakeWebSocket.instances.push(this);
    }

    close() {
        this.readyState = FakeWebSocket.CLOSED;
    }

    sent: unknown[] = [];

    send(data: unknown) {
        this.sent.push(data);
    }

    simulateOpen() {
        this.readyState = FakeWebSocket.OPEN;
        this.onopen?.(new Event('open'));
    }

    simulateMessage(data: unknown) {
        this.onmessage?.(new MessageEvent('message', {data}));
    }

    simulateClose(code: number) {
        this.readyState = FakeWebSocket.CLOSED;
        this.onclose?.(new CloseEvent('close', {code}));
    }
}

const last = () => FakeWebSocket.instances[FakeWebSocket.instances.length - 1];

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return {promise, resolve, reject};
};

const actionResponse = (url: string) => new Response(JSON.stringify({
    type: 'success',
    status: 200,
    data: stringify({url})
}));

// Long enough for the action response body to be read and parsed.
const flush = () => new Promise((resolve) => setTimeout(resolve, 50));

// Renders the component and hands back the controller passed to its `controller` snippet.
const mount = async (props: Record<string, unknown>) => {
    let ctrl: ActionSocketController | undefined;
    const controller = createRawSnippet((get: () => ActionSocketController) => {
        ctrl = get();
        return {render: () => '<span></span>'};
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await render(WebSocketComponent as any, {props: {...props, controller}});
    if (!ctrl) throw new Error('controller snippet was not rendered');
    return {...result, ctrl};
};

beforeEach(() => {
    FakeWebSocket.instances = [];
    vi.stubGlobal('WebSocket', FakeWebSocket);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe('WebSocket component', () => {
    it('does not open a second socket while the first is still connecting', async () => {
        const {ctrl} = await mount({url: 'ws://example.test/socket'});

        await Promise.all([ctrl.open(), ctrl.open()]);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('shares one action request between concurrent open() calls', async () => {
        const response = deferred<Response>();
        const fetch = vi.fn(() => response.promise);
        vi.stubGlobal('fetch', fetch);

        const {ctrl} = await mount({action: '?/ws', auto_open: false});
        const first = ctrl.open();
        const second = ctrl.open();
        response.resolve(actionResponse('ws://example.test/a'));
        await Promise.all([first, second]);

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('does not open a socket when unmounted while the action is in flight', async () => {
        const response = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn(() => response.promise));

        const {unmount} = await mount({action: '?/ws'});
        await unmount();
        response.resolve(actionResponse('ws://example.test/a'));
        await flush();

        expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it('does not open a socket when close() runs while the action is in flight', async () => {
        const response = deferred<Response>();
        vi.stubGlobal('fetch', vi.fn(() => response.promise));

        const {ctrl} = await mount({action: '?/ws', auto_open: false});
        const opening = ctrl.open();
        ctrl.close();
        response.resolve(actionResponse('ws://example.test/a'));
        await opening;

        expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it('opens again after close()', async () => {
        const {ctrl} = await mount({url: 'ws://example.test/socket'});
        ctrl.close();
        await ctrl.open();

        expect(FakeWebSocket.instances).toHaveLength(2);
    });
});

describe('WebSocket component reconnect', () => {
    // Mount first, then fake timers, so rendering itself runs on real timers. Math.random() = 1 makes
    // every delay the full backoff ceiling.
    const mountWithFakeTimers = async (props: Record<string, unknown>) => {
        const mounted = await mount(props);
        vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
        vi.spyOn(Math, 'random').mockReturnValue(1);
        return mounted;
    };

    it('does not reconnect unless enabled', async () => {
        await mountWithFakeTimers({url: 'ws://example.test/socket'});

        last().simulateClose(1006);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('reconnects after the connection drops', async () => {
        const onreconnect = vi.fn();
        const {ctrl} = await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true, onreconnect});
        last().simulateOpen();

        last().simulateClose(1006);
        expect(ctrl.reconnecting).toBe(true);
        expect(onreconnect).toHaveBeenCalledWith(1, 1000);

        await vi.advanceTimersByTimeAsync(999);
        expect(FakeWebSocket.instances).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1);
        expect(FakeWebSocket.instances).toHaveLength(2);
        expect(ctrl.reconnecting).toBe(false);
    });

    it('backs off exponentially up to maxDelay and resets after a successful open', async () => {
        const delays: number[] = [];
        await mountWithFakeTimers({
            url: 'ws://example.test/socket',
            reconnect: {delay: 100, factor: 3, maxDelay: 1000},
            onreconnect: (_attempt: number, delay: number) => delays.push(delay)
        });

        for (let i = 0; i < 4; i++) {
            last().simulateClose(1006);
            await vi.advanceTimersByTimeAsync(1000);
        }
        last().simulateOpen();
        last().simulateClose(1006);

        expect(delays).toEqual([100, 300, 900, 1000, 100]);
    });

    it('jitters the delay to between half and all of the backoff', async () => {
        const onreconnect = vi.fn();
        await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true, onreconnect});
        vi.mocked(Math.random).mockReturnValue(0);

        last().simulateClose(1006);

        expect(onreconnect).toHaveBeenCalledWith(1, 500);
    });

    it('stops after `retries` consecutive attempts', async () => {
        await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: {retries: 2}});

        for (let i = 0; i < 4; i++) {
            last().simulateClose(1006);
            await vi.advanceTimersByTimeAsync(60_000);
        }

        expect(FakeWebSocket.instances).toHaveLength(3);
    });

    it.each([
        [1000, false],
        [1005, false],
        [1008, false],
        [1001, true],
        [1006, true],
        [1013, true],
    ])('by default treats close code %i as reconnect = %s', async (code, reconnects) => {
        await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true});

        last().simulateClose(code);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWebSocket.instances).toHaveLength(reconnects ? 2 : 1);
    });

    it('lets shouldReconnect decide', async () => {
        const shouldReconnect = vi.fn((ev: CloseEvent) => ev.code === 4000);
        await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: {shouldReconnect}});

        last().simulateClose(1006);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(FakeWebSocket.instances).toHaveLength(1);

        last().simulateClose(4000);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('does not reconnect after close()', async () => {
        const {ctrl} = await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true});
        const socket = last();
        socket.simulateOpen();

        ctrl.close();
        socket.simulateClose(1006);
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('close() cancels a scheduled reconnect', async () => {
        const {ctrl} = await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true});

        last().simulateClose(1006);
        expect(ctrl.reconnecting).toBe(true);
        ctrl.close();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(ctrl.reconnecting).toBe(false);
        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('open() connects right away instead of waiting for the scheduled reconnect', async () => {
        const {ctrl} = await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true});

        last().simulateClose(1006);
        await ctrl.open();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(ctrl.reconnecting).toBe(false);
        expect(FakeWebSocket.instances).toHaveLength(2);
    });

    it('does not reconnect after unmount', async () => {
        const {unmount} = await mountWithFakeTimers({url: 'ws://example.test/socket', reconnect: true});

        last().simulateClose(1006);
        await unmount();
        await vi.advanceTimersByTimeAsync(60_000);

        expect(FakeWebSocket.instances).toHaveLength(1);
    });

    it('re-runs the action on every attempt', async () => {
        let n = 0;
        const fetch = vi.fn(async () => actionResponse(`ws://example.test/${++n}`));
        vi.stubGlobal('fetch', fetch);

        await mountWithFakeTimers({action: '?/ws', reconnect: true});
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

        last().simulateClose(1006);
        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(FakeWebSocket.instances.map((ws) => ws.url)).toEqual(['ws://example.test/1', 'ws://example.test/2']);
    });

    it('retries a failed action request', async () => {
        const onerror = vi.fn();
        // Fail the first request only once fake timers are installed; otherwise the retry can be scheduled on
        // a real timer with a random delay.
        const first = deferred<Response>();
        const fetch = vi.fn()
            .mockImplementationOnce(() => first.promise)
            .mockImplementation(async () => actionResponse('ws://example.test/a'));
        vi.stubGlobal('fetch', fetch);

        await mountWithFakeTimers({action: '?/ws', reconnect: true, onerror});
        first.reject(new TypeError('Failed to fetch'));
        await vi.waitFor(() => expect(onerror).toHaveBeenCalledTimes(1));

        await vi.advanceTimersByTimeAsync(1000);
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
        expect(fetch).toHaveBeenCalledTimes(2);
    });
});

describe('WebSocket component data', () => {
    // Renders `data` as JSON through the `messages` snippet, so the test reads what the component holds.
    const messages = createRawSnippet((getData: () => unknown[]) => ({
        render: () => '<output></output>',
        setup: (node: Element) => {
            $effect(() => {
                node.textContent = JSON.stringify(getData());
            });
        }
    }));

    const received = async (props: Record<string, unknown>, count: number) => {
        const {container} = await mount({url: 'ws://example.test/socket', messages, ...props});
        last().simulateOpen();
        for (let i = 1; i <= count; i++) last().simulateMessage(i);
        await flush();
        return JSON.parse(container.querySelector('output')?.textContent || 'null');
    };

    it('keeps the latest max_messages messages', async () => {
        expect(await received({max_messages: 3}, 5)).toEqual([3, 4, 5]);
    });

    it('keeps 1000 messages by default', async () => {
        const data = await received({}, 1005);
        expect(data).toHaveLength(1000);
        expect(data[0]).toBe(6);
        expect(data[999]).toBe(1005);
    });

    it('keeps everything with Infinity', async () => {
        expect(await received({max_messages: Infinity}, 1005)).toHaveLength(1005);
    });

    it('keeps nothing with 0 but still calls onmessage', async () => {
        const onmessage = vi.fn();
        expect(await received({max_messages: 0, onmessage}, 3)).toEqual([]);
        expect(onmessage).toHaveBeenCalledTimes(3);
    });
});

describe('WebSocket component codec', () => {
    const messages = createRawSnippet((getData: () => unknown[]) => ({
        render: () => '<output></output>',
        setup: (node: Element) => {
            $effect(() => {
                node.textContent = JSON.stringify(getData());
            });
        }
    }));

    const opened = async (props: Record<string, unknown>) => {
        const mounted = await mount({url: 'ws://example.test/socket', messages, ...props});
        last().simulateOpen();
        return mounted;
    };

    const shown = async (container: HTMLElement) => {
        await flush();
        return JSON.parse(container.querySelector('output')?.textContent || 'null');
    };

    it('keeps raw data without a codec', async () => {
        const {container} = await opened({});
        last().simulateMessage('{"n":1}');

        expect(await shown(container)).toEqual(['{"n":1}']);
    });

    it("decodes messages with 'json' for data and onmessage", async () => {
        const onmessage = vi.fn();
        const {container} = await opened({codec: 'json', onmessage});
        last().simulateMessage('{"n":1}');

        expect(await shown(container)).toEqual([{n: 1}]);
        expect(onmessage.mock.calls[0][0].data).toEqual({n: 1});
    });

    it('skips a message that fails to decode and reports it through onerror', async () => {
        const onerror = vi.fn();
        const {container} = await opened({codec: 'json', onerror});
        last().simulateMessage('{broken');
        last().simulateMessage(new ArrayBuffer(4));
        last().simulateMessage('{"n":2}');

        expect(await shown(container)).toEqual([{n: 2}]);
        expect(onerror).toHaveBeenCalledTimes(2);
    });

    it("decodes Dates with 'devalue'", async () => {
        const onmessage = vi.fn();
        await opened({codec: 'devalue', onmessage});
        last().simulateMessage(stringify({at: new Date(1000)}));

        const message = onmessage.mock.calls[0][0].data;
        expect(message.at).toBeInstanceOf(Date);
        expect(message.at.getTime()).toBe(1000);
    });

    it('lets a custom codec validate', async () => {
        const onerror = vi.fn();
        const codec = {
            encode: JSON.stringify,
            decode: (data: string) => {
                const value = JSON.parse(data);
                if (typeof value.n !== 'number') throw new Error('invalid');
                return value;
            }
        };
        const {container} = await opened({codec, onerror});
        last().simulateMessage('{"n":"x"}');
        last().simulateMessage('{"n":3}');

        expect(await shown(container)).toEqual([{n: 3}]);
        expect(onerror).toHaveBeenCalledTimes(1);
    });

    it('send() encodes with the codec, sends raw without one, and refuses while not open', async () => {
        const typed = await mount({url: 'ws://example.test/a', codec: 'devalue'});
        expect(typed.ctrl.send({at: new Date(5)})).toBe(false);
        last().simulateOpen();
        expect(typed.ctrl.send({at: new Date(5)})).toBe(true);
        expect(parse(last().sent[0] as string).at.getTime()).toBe(5);

        const raw = await mount({url: 'ws://example.test/b'});
        last().simulateOpen();
        raw.ctrl.send('plain');
        expect(last().sent).toEqual(['plain']);
    });
});

describe('WebSocket component connection keys', () => {
    it('sends a url key in the subprotocols instead of the URL', async () => {
        await mount({url: 'ws://example.test/chat?room=1&key=secret', protocols: ['mine']});

        expect(last().url).toBe('ws://example.test/chat?room=1');
        expect(last().protocols).toEqual(['mine', 'sveltekit-websockets', 'sveltekit-websockets.key.secret']);
    });

    it('does the same for the URL an action returns', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => actionResponse('ws://example.test/chat?key=from-action')));

        await mount({action: '?/ws'});
        await vi.waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));

        expect(last().url).toBe('ws://example.test/chat');
        expect(last().protocols).toEqual(['sveltekit-websockets', 'sveltekit-websockets.key.from-action']);
    });

    it('leaves URLs without a key alone', async () => {
        await mount({url: 'ws://example.test/chat'});

        expect(last().url).toBe('ws://example.test/chat');
        expect(last().protocols).toEqual([]);
    });
});
