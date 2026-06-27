import {describe, expect, it} from 'vitest';
import {WebSocketEndpointController} from './index.js';

type ControllerInternals = {
    cleanupTimer?: NodeJS.Timeout
    pendingKeys: Map<string, { expiresAt: number }>
    rateLimitMap: Map<string, { count: number; resetTime: number }>
    cleanupExpiredState(): void
}

describe('WebSocketEndpointController', () => {
    it('clears its pending-key cleanup interval when destroyed', () => {
        const controller = new WebSocketEndpointController('/test', {});
        const internals = controller as unknown as ControllerInternals;

        expect(internals.cleanupTimer).toBeDefined();

        controller.destroy();

        expect(internals.cleanupTimer).toBeUndefined();
    });

    it('cleans expired pending keys and rate-limit entries', () => {
        const controller = new WebSocketEndpointController('/test', {});
        const internals = controller as unknown as ControllerInternals;
        const now = Date.now();

        internals.pendingKeys.set('expired', {
            expiresAt: now - 1
        } as { expiresAt: number });
        internals.pendingKeys.set('active', {
            expiresAt: now + 1000
        } as { expiresAt: number });
        internals.rateLimitMap.set('expired', {
            count: 1,
            resetTime: now - 1
        });
        internals.rateLimitMap.set('active', {
            count: 1,
            resetTime: now + 1000
        });

        internals.cleanupExpiredState();

        expect(internals.pendingKeys.has('expired')).toBe(false);
        expect(internals.pendingKeys.has('active')).toBe(true);
        expect(internals.rateLimitMap.has('expired')).toBe(false);
        expect(internals.rateLimitMap.has('active')).toBe(true);

        controller.destroy();
    });
});
