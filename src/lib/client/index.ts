import {default as CP} from "./WebSocket.svelte"

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
    type Codec,
    type CodecOption,
    type ActionSocketController,
    type ReconnectOptions,
    type ActionSocketResult,
    type WebSocketEvents,
    type WebSocketProps,
    type WebSocketSnippets
} from "./actions.js"

export default CP
