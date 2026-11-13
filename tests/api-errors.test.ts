import { expect, spyOn, test } from "bun:test";
import { api, ApiError } from "../src/web/api";

test("API failures retain machine codes, workflow reasons and retry timing", async () => {
  const send = spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "Use the original invitation", code: "forbidden", reason: "private_invitation_required" }, { status: 403, headers: { "retry-after": "5" } }));
  try {
    let failure: unknown;
    try { await api("POST", "/fixture", {}); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(ApiError);
    expect(failure).toMatchObject({ status: 403, code: "forbidden", reason: "private_invitation_required", retryAfterMs: 5000 });
  } finally { send.mockRestore(); }
});

test("a malformed failure body remains an HTTP failure rather than a null dereference", async () => {
  const send = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(null, { status: 503 }));
  try { await expect(api("GET", "/fixture")).rejects.toMatchObject({ status: 503, message: "Request failed (503)" }); }
  finally { send.mockRestore(); }
});
