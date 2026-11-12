/*
 * Manual CONNECTION-ONLY probe for the user's signed-in Multi dashboard.
 * Copy into its developer console. This uses the current dashboard login,
 * whose authority is broader than the review key, only inside this browser.
 * No cookies/tokens are exported or stored; the one-use ticket stays out of URLs.
 * Creates at most one fresh empty paperwork-review session. NO prompt, model
 * call, app connection, config change, restart, or payment action is sent.
 * Contracts: NousResearch/hermes-agent v0.23.0 dashboard_auth/routes.py,
 * web_server_boundary.py and tui_gateway/contracts/{common,canonical_sessions}.py.
 */
(async () => {
  const origin = "https://multi-7009.agents.nousresearch.com";
  const profile = "paperwork-review";
  const model = "z-ai/glm-5.3-flash";
  const once = Symbol.for("paperwork.review.dashboard.connection-probe");
  const attempts = { ticket: 0, ping: 0, runtime: 0, session_create: 0, prompts: 0 };
  const handshake = { negotiated_protocol: "not_observed", jsonrpc: "not_observed", ready_received: false,
    session_authority: "not_observed", ping_acknowledged: false, refusal: null };
  const allowed = new Set(["wrong_origin", "already_attempted", "ticket_refused", "ticket_invalid", "transport_failed",
    "transport_timeout", "protocol_unavailable", "rpc_refused", "runtime_incompatible", "session_unverified", "response_too_large"]);
  const rpcReasons = new Set(["invalid_params", "profile_mismatch", "runtime_draining", "permission_denied", "not_found",
    "admission_conflict", "session_busy", "backend_unavailable"]);
  const rpcFields = new Set(["profile", "request_id", "source", "model", "provider", "toolsets", "max_turns", "skills",
    "run_budget", "follow_profile_config"]);
  let stage = "origin", socket, readyReject, readyTimer, received = 0, nextId = 0, sessionObserved = false, transportFault;
  let ticketStatus = null, rpcRefusal = null;
  const pending = new Map();
  const failure = (code) => new Error(code);
  const failPending = (code) => {
    transportFault = code;
    clearTimeout(readyTimer);
    if (readyReject) { readyReject(failure(code)); readyReject = undefined; }
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(failure(code)); }
    pending.clear();
  };
  const rpc = (method, params, timeout) => new Promise((resolve, reject) => {
    if (transportFault) { reject(failure(transportFault)); return; }
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(failure("transport_timeout")); }, timeout);
    pending.set(id, { resolve, reject, timer, method });
    try { socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params })); }
    catch { clearTimeout(timer); pending.delete(id); reject(failure("transport_failed")); }
  });
  try {
    if (location.origin !== origin) throw failure("wrong_origin");
    if (globalThis[once]) throw failure("already_attempted");
    globalThis[once] = true;
    stage = "ticket";
    attempts.ticket++;
    const response = await fetch(origin + "/api/auth/ws-ticket", {
      method: "POST", credentials: "same-origin", redirect: "error", cache: "no-store",
      signal: AbortSignal.timeout(10000)
    });
    if (Number.isInteger(response.status) && response.status >= 100 && response.status <= 599) ticketStatus = response.status;
    if (!response.ok) throw failure("ticket_refused");
    const ticketBody = await response.text();
    if (ticketBody.length > 4096) throw failure("response_too_large");
    const ticket = JSON.parse(ticketBody);
    if (typeof ticket.ticket !== "string" || !/^[A-Za-z0-9_-]{32,200}$/.test(ticket.ticket) || ticket.ttl_seconds !== 30)
      throw failure("ticket_invalid");
    stage = "websocket";
    await new Promise((resolve, reject) => {
      readyReject = reject;
      readyTimer = setTimeout(() => failPending("transport_timeout"), 15000);
      // The server reflects only hermes-gateway-v1, never the credential protocol.
      socket = new WebSocket("wss://multi-7009.agents.nousresearch.com/api/ws", [
        "hermes-gateway-v1", "hermes-gateway-ticket." + ticket.ticket
      ]);
      socket.onclose = socket.onerror = () => failPending("transport_failed");
      socket.onmessage = (event) => {
        try {
          if (typeof event.data !== "string" || event.data.length > 65536 || (received += event.data.length) > 262144)
            throw failure("response_too_large");
          const frame = JSON.parse(event.data);
          if (!handshake.ready_received) {
            handshake.negotiated_protocol = socket.protocol === "hermes-gateway-v1" ? "expected" : socket.protocol === "" ? "none" : "other";
            handshake.jsonrpc = frame?.jsonrpc === "2.0" ? "expected" : frame?.jsonrpc === undefined ? "missing" : "other";
          }
          if (frame?.jsonrpc !== "2.0") {
            if (!handshake.refusal) handshake.refusal = "invalid_jsonrpc";
            throw failure("protocol_unavailable");
          }
          if (frame.method === "event" && frame.params?.type === "gateway.ready" && readyReject) {
            handshake.ready_received = true;
            const authority = frame.params.payload?.session_authority;
            handshake.session_authority = authority === true ? "true" : authority === false ? "false" : authority === undefined ? "missing" : "invalid";
            clearTimeout(readyTimer); readyReject = undefined; resolve();
          } else if (pending.has(frame.id)) {
            const request = pending.get(frame.id);
            pending.delete(frame.id); clearTimeout(request.timer);
            if (frame.error || !Object.hasOwn(frame, "result")) {
              rpcRefusal = { method: request.method,
                code: [4001, -32600, -32601, -32602, -32603, -32700].includes(frame.error?.code) ? frame.error.code : "other",
                reason: rpcReasons.has(frame.error?.data?.reason) ? frame.error.data.reason : "other",
                field: rpcFields.has(frame.error?.data?.field) ? frame.error.data.field : "other" };
              request.reject(failure("rpc_refused"));
            } else request.resolve(frame.result);
          }
          // All other events, including other sessions' text, are discarded.
        } catch (error) {
          if (!handshake.refusal && !handshake.ready_received) handshake.refusal = "invalid_frame";
          failPending(allowed.has(error?.message) ? error.message : "protocol_unavailable");
        }
      };
    });
    if (handshake.negotiated_protocol !== "expected" || handshake.session_authority !== "true") {
      handshake.refusal = handshake.negotiated_protocol !== "expected" ? "subprotocol_mismatch" : "canonical_authority_unavailable";
      // This transport-level method exists in canonical and legacy modes. A
      // successful ping never authorizes canonical create against a legacy server.
      attempts.ping++;
      try { handshake.ping_acknowledged = (await rpc("gateway.ping", {}, 5000))?.ok === true; }
      catch { /* Preserve the handshake refusal; no fallback or session creation. */ }
      throw failure("protocol_unavailable");
    }
    stage = "runtime";
    attempts.runtime++;
    const runtime = await rpc("runtime.describe", {}, 10000);
    if (!Array.isArray(runtime?.capabilities) ||
        !["durable-admission-v1", "local-cli-create-v1"].every((capability) => runtime.capabilities.includes(capability)) ||
        !Array.isArray(runtime.session_create?.sources) || !runtime.session_create.sources.includes("oneshot") ||
        !Array.isArray(runtime.session_create?.parameters) ||
        !["model", "provider", "toolsets", "max_turns"].every((field) => runtime.session_create.parameters.includes(field)))
      throw failure("runtime_incompatible");
    stage = "session";
    attempts.session_create++;
    // A fixed title may resume a named session; omit it and use a fresh create id.
    const snapshot = await rpc("session.create", {
      profile, request_id: crypto.randomUUID(), source: "oneshot", model, provider: "custom:near",
      toolsets: ["no_mcp"], max_turns: 2, follow_profile_config: false,
      skills: [], checkpoints: false, accept_hooks: false, run_budget: 60
    }, 30000);
    sessionObserved = typeof snapshot?.session_id === "string" && snapshot.session_id.length > 0;
    stage = "metadata";
    if (!sessionObserved || snapshot.info?.profile_name !== profile || snapshot.info?.model !== model ||
        typeof snapshot.info?.profile_id !== "string" || !snapshot.info.profile_id || snapshot.info?.source !== "oneshot" ||
        snapshot.info?.desktop_protocol !== "hermes-gateway-v1" || snapshot.info?.tool_count !== 0 ||
        snapshot.running !== false || snapshot.message_count !== 0 ||
        !Array.isArray(snapshot.messages) || snapshot.messages.length !== 0 ||
        !Array.isArray(snapshot.pending) || snapshot.pending.length !== 0 ||
        !Array.isArray(snapshot.prompts) || snapshot.prompts.length !== 0)
      throw failure("session_unverified");
    console.log({ check: "dashboard_connection_only", outcome: "pass", profile,
      model_metadata: model, advertised_tool_count: 0, session_observed: true, attempts, handshake,
      inference_tested: false, app_connected: false });
  } catch (error) {
    console.log({ check: "dashboard_connection_only", outcome: "blocked", profile, stage,
      code: allowed.has(error?.message) ? error.message : "transport_failed",
      ticket_http_status: ticketStatus, rpc_refusal: rpcRefusal,
      session_observed: sessionObserved, attempts, handshake, inference_tested: false, app_connected: false });
  } finally {
    failPending("transport_failed");
    if (socket) { socket.onmessage = socket.onerror = socket.onclose = null; socket.close(); }
  }
})();
