/**
 * Connection keys travel in the `Sec-WebSocket-Protocol` header instead of the URL, so they don't end up in
 * access logs, proxy logs or monitoring that records request URLs. Browsers can set nothing else on a
 * WebSocket handshake. The client offers {@link KEY_PROTOCOL} plus `${KEY_PROTOCOL_PREFIX}<key>`; the server
 * answers with a protocol that doesn't carry the key.
 */
export const KEY_PROTOCOL = 'sveltekit-websockets';
export const KEY_PROTOCOL_PREFIX = `${KEY_PROTOCOL}.key.`;

/**
 * Moves a `?key=` connection key from a WebSocket URL into the subprotocol list, for passing to
 * `new WebSocket(url, protocols)`. Your own protocols stay first, so the server keeps picking yours. A URL
 * without a key is returned unchanged.
 */
export const splitConnectionKey = (
    url: string | URL,
    protocols: string | string[] = []
): { url: string, protocols: string[] } => {
    const list = typeof protocols === 'string' ? [protocols] : [...protocols];
    const href = url.toString();
    // Works on the string so relative URLs keep their exact form.
    const hashAt = href.indexOf('#');
    const hash = hashAt < 0 ? '' : href.slice(hashAt);
    const withoutHash = hashAt < 0 ? href : href.slice(0, hashAt);
    const queryAt = withoutHash.indexOf('?');
    if (queryAt < 0) return {url: href, protocols: list};

    const params = new URLSearchParams(withoutHash.slice(queryAt + 1));
    const key = params.get('key');
    if (!key) return {url: href, protocols: list};
    params.delete('key');
    const query = params.toString();

    return {
        url: withoutHash.slice(0, queryAt) + (query ? `?${query}` : '') + hash,
        protocols: [...list.filter((protocol) => !protocol.startsWith(KEY_PROTOCOL_PREFIX) && protocol !== KEY_PROTOCOL),
            KEY_PROTOCOL, KEY_PROTOCOL_PREFIX + key]
    };
};
