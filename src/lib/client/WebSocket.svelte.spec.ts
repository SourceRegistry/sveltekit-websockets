import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {render} from 'vitest-browser-svelte';
import {createRawSnippet} from 'svelte';
import {stringify} from 'devalue';
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

    send() {
    }
}

const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => resolve = r);
    return {promise, resolve};
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
