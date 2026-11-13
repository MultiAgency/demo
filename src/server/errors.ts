/** A refusal or failure to show the caller, with its HTTP status. */
export class UserError extends Error {
  constructor(
    message: string,
    readonly status = 400,
    readonly reason?: "private_invitation_required" | "account_mismatch" | "named_party_required",
  ) {
    super(message);
  }
}

/** Machine-readable class of a refusal, so API clients and agents need not parse the message. */
export function errorCode(status: number): string {
  return ({ 400: "invalid_request", 401: "sign_in_required", 403: "forbidden", 404: "not_found", 409: "conflict", 413: "too_large", 421: "wrong_host", 429: "rate_limited", 502: "upstream_unavailable", 503: "unavailable" } as Record<number, string>)[status]
    ?? (status >= 500 ? "internal" : "invalid_request");
}

/**
 * A request body that is not JSON is the caller's mistake (400), not a server failure. Untyped like Hono's own
 * `c.req.json()`; each route validates it with its schema.
 */
export async function jsonBody(c: { req: { json(): Promise<any> } }): Promise<any> {
  try {
    return await c.req.json();
  } catch {
    throw new UserError("The request body must be valid JSON.", 400);
  }
}
