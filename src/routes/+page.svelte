<script lang="ts">
    import WebSocket from "$lib/client/index.js"; //!IMPORTANT use in production "@sourceregistry/sveltekit-websockets" <<-- This uses the client
</script>

<WebSocket action="?/ws">
    {#snippet message(data)}
        <p>{new Date().toLocaleString()}: {data}</p>
    {/snippet}
</WebSocket>
