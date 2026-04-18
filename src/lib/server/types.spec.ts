import {describe, expect, it} from 'vitest';
import {WebSockets, websockets} from './index.js';
import type {ReferencedWebSocket, WebSocketEndpointController} from './index.js';

type Equal<A, B> =
    (<T>() => T extends A ? 1 : 2) extends
        (<T>() => T extends B ? 1 : 2) ? true : false;

type Expect<T extends true> = T;

type UseHandler = Parameters<typeof websockets.use>[1];
type UseWebSocket = Parameters<UseHandler>[0];
type UseController = Parameters<UseHandler>[1];

type WebSocketsUseHandler = Parameters<typeof WebSockets.use>[1];
type WebSocketsUseWebSocket = Parameters<WebSocketsUseHandler>[0];
type WebSocketsUseController = Parameters<WebSocketsUseHandler>[1];

type _websocketsUseSocketIsReferenced = Expect<Equal<UseWebSocket, ReferencedWebSocket>>;
type _websocketsUseControllerIsEndpointController = Expect<Equal<UseController, WebSocketEndpointController>>;
type _webSocketsUseSocketIsReferenced = Expect<Equal<WebSocketsUseWebSocket, ReferencedWebSocket>>;
type _webSocketsUseControllerIsEndpointController = Expect<Equal<WebSocketsUseController, WebSocketEndpointController>>;

describe('server export types', () => {
    it('exposes websockets.use with a ReferencedWebSocket connection handler', () => {
        expect(websockets.use).toBe(WebSockets.use);
    });
});
