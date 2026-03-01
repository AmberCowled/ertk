/**
 * ERTK Rate Limiting
 *
 * Pluggable rate limiting for server-side route handlers.
 * Ships with an in-memory sliding window adapter suitable for
 * single-process deployments. For multi-instance / serverless
 * deployments (e.g., Vercel), provide a distributed adapter
 * (Redis, Upstash, DynamoDB, etc.).
 */

// ─── Interfaces ───────────────────────────────────────────────

/** Result of a rate limit check. */
export interface RateLimitResult {
	/** Whether the request is allowed */
	allowed: boolean;
	/** Total limit for the window */
	limit: number;
	/** Remaining requests in the current window */
	remaining: number;
	/** Unix timestamp (seconds) when the window resets */
	resetAt: number;
}

/**
 * Pluggable rate limiting adapter interface.
 * Implement this for custom storage backends (Redis, Upstash, DynamoDB, etc.).
 */
export interface RateLimitAdapter {
	/**
	 * Check and consume a rate limit token for the given key.
	 * @param key   Identifier for the rate limit bucket (typically IP or user ID)
	 * @param windowMs  Sliding window duration in milliseconds
	 * @param max   Maximum requests allowed in the window
	 */
	check(key: string, windowMs: number, max: number): Promise<RateLimitResult>;
}

/** Rate limit configuration for `configureHandler()`. */
export interface RateLimitConfig {
	/** Sliding window duration in milliseconds (e.g., 60_000 for 1 minute) */
	windowMs: number;
	/** Maximum requests allowed within the window */
	max: number;
	/**
	 * Function to derive the rate limit key from a request.
	 * Receives the authenticated user when available.
	 * Default: extract client IP from standard proxy headers.
	 */
	keyFn?: (req: Request, user?: { id: string }) => string;
	/**
	 * Rate limit storage adapter.
	 * Default: InMemoryRateLimitAdapter (suitable for single-process deployments).
	 */
	adapter?: RateLimitAdapter;
}

// ─── Default Key Function ─────────────────────────────────────

/**
 * Default key function: extracts client IP from standard proxy headers,
 * falling back to a static key if no IP is available.
 */
export function defaultKeyFn(req: Request): string {
	const forwarded = req.headers.get("x-forwarded-for");
	if (forwarded) {
		return forwarded.split(",")[0].trim();
	}

	const realIp = req.headers.get("x-real-ip");
	if (realIp) return realIp.trim();

	return "unknown";
}

// ─── In-Memory Adapter ───────────────────────────────────────

interface WindowEntry {
	timestamps: number[];
}

/**
 * In-memory sliding window rate limiter.
 *
 * Suitable for single-process deployments (e.g., a long-running Node.js server).
 * State resets on process restart and is not shared across instances.
 * For multi-instance or serverless deployments, use a distributed adapter.
 *
 * Periodically prunes expired entries to prevent memory leaks.
 */
export class InMemoryRateLimitAdapter implements RateLimitAdapter {
	private windows = new Map<string, WindowEntry>();
	private pruneIntervalMs: number;
	private lastPrune = Date.now();

	constructor(options?: { pruneIntervalMs?: number }) {
		this.pruneIntervalMs = options?.pruneIntervalMs ?? 60_000;
	}

	async check(
		key: string,
		windowMs: number,
		max: number,
	): Promise<RateLimitResult> {
		const now = Date.now();
		this.maybePrune(now, windowMs);

		let entry = this.windows.get(key);
		if (!entry) {
			entry = { timestamps: [] };
			this.windows.set(key, entry);
		}

		// Remove timestamps outside the current window
		const windowStart = now - windowMs;
		entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

		const resetAt = Math.ceil((now + windowMs) / 1000);

		if (entry.timestamps.length >= max) {
			return { allowed: false, limit: max, remaining: 0, resetAt };
		}

		entry.timestamps.push(now);
		const remaining = max - entry.timestamps.length;
		return { allowed: true, limit: max, remaining, resetAt };
	}

	private maybePrune(now: number, windowMs: number): void {
		if (now - this.lastPrune < this.pruneIntervalMs) return;
		this.lastPrune = now;
		const cutoff = now - windowMs;
		for (const [key, entry] of this.windows) {
			entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
			if (entry.timestamps.length === 0) {
				this.windows.delete(key);
			}
		}
	}
}
