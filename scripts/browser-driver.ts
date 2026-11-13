/** Drives named agent-browser sessions for the browser walkthroughs. Every account, signature and payment is a fixture. */
import { join } from "node:path";

export function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const pause = () => Bun.sleep(150);

export function browserDriver<Actor extends string>(sessions: Record<Actor, string>, artifacts: string) {
  const opened = new Set<Actor>();
  const captures: string[] = [];

  async function command(actor: Actor, ...args: string[]) {
    const child = Bun.spawn(["agent-browser", "--session", sessions[actor], "--json", ...args], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, AGENT_BROWSER_DEFAULT_TIMEOUT: "5000" },
    });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15_000);
    try {
      const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      check(exit === 0, `Browser ${args[0]} failed (${exit}): ${stderr || stdout}`);
      const result = JSON.parse(stdout);
      check(result.success, `Browser ${args[0]} failed: ${result.error}`);
      return result.data;
    } finally { clearTimeout(timeout); }
  }
  async function evaluate<T>(actor: Actor, expression: string): Promise<T> {
    return (await command(actor, "eval", expression)).result as T;
  }
  async function pageWait(actor: Actor, expression: string, label: string) {
    for (const end = Date.now() + 12_000; Date.now() < end; await pause()) {
      if (await evaluate<boolean>(actor, expression)) return;
    }
    throw new Error(`Timed out waiting for ${label}`);
  }
  async function reference(actor: Actor, role: string, name: string, prefix = false) {
    const snapshot = await command(actor, "snapshot", "-i");
    const entry = Object.entries(snapshot.refs as Record<string, { role: string; name: string }>).find(([, value]) =>
      value.role === role && (prefix ? value.name.startsWith(name) : value.name === name));
    check(entry, `No ${role} named ${name}`);
    return `@${entry[0]}`;
  }
  /** agent-browser clicks offscreen coordinates without scrolling, so every target is revealed first. */
  async function activate(actor: Actor, role: string, name: string, prefix = false) {
    await command(actor, "scrollintoview", await reference(actor, role, name, prefix));
    await command(actor, "click", await reference(actor, role, name, prefix));
    await pause();
  }
  async function button(actor: Actor, text: string) {
    await pageWait(actor, `[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(text)}&&!b.disabled)`, text);
    await activate(actor, "button", text);
  }
  async function fill(actor: Actor, label: string, value: string) {
    await command(actor, "scrollintoview", await reference(actor, "textbox", label, true));
    await command(actor, "fill", await reference(actor, "textbox", label, true), value);
  }
  async function open(actor: Actor, url: string) {
    opened.add(actor);
    await command(actor, "open", url);
    await command(actor, "set", "viewport", "1440", "1000");
  }
  async function capture(actor: Actor, name: string) {
    const path = join(artifacts, `${name}.png`);
    await command(actor, "screenshot", path, "--full");
    captures.push(path);
  }
  const text = (actor: Actor) => evaluate<string>(actor, "document.body.innerText");
  async function close() {
    for (const actor of opened) { try { await command(actor, "close"); } catch { /* The session may already be gone. */ } }
  }
  return { opened, captures, command, evaluate, pageWait, activate, button, fill, open, capture, text, close };
}
