import {describe, expect, it} from 'vitest';
import {WebSocketEndpointController} from './index.js';

type ControllerInternals = {
    cleanupTimer?: NodeJS.Timeout
}

describe('WebSocketEndpointController', () => {
    it('clears its pending-key cleanup interval when destroyed', () => {
        const controller = new WebSocketEndpointController('/test', {});
        const internals = controller as unknown as ControllerInternals;

        expect(internals.cleanupTimer).toBeDefined();

        controller.destroy();

        expect(internals.cleanupTimer).toBeUndefined();
    });
});
