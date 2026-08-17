/**
 * Minimal pub/sub bridging src/lib/api.ts (a plain module — no React
 * context available) to AuthContext.tsx's logout, so a 401 the API client
 * can't recover from (see api.ts's refresh-then-retry logic) can still
 * trigger a real sign-out without the two modules importing each other.
 */
type UnauthorizedHandler = () => void;

let handler: UnauthorizedHandler | null = null;

export function onUnauthorized(nextHandler: UnauthorizedHandler): void {
  handler = nextHandler;
}

export function emitUnauthorized(): void {
  handler?.();
}
