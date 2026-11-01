import { type ReactNode, useState } from "react";
import { guideFor, type StepId } from "../guide";

export function usdText(v: string | number): string {
  const n = typeof v === "string" ? Number(v) : v;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD" });
}

export function shortHash(h: string, n = 10): string {
  return h.length > n * 2 ? `${h.slice(0, n)}…${h.slice(-4)}` : h;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC";
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => unknown | Promise<unknown>;
  kind?: "primary" | "secondary" | "danger" | "ghost";
  disabled?: boolean;
  type?: "button" | "submit";
  small?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={props.type ?? "button"}
      className={`btn btn-${props.kind ?? "primary"}${props.small ? " btn-small" : ""}`}
      disabled={props.disabled || busy}
      onClick={async () => {
        if (!props.onClick) return;
        setBusy(true);
        try {
          await props.onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? <span className="spinner" aria-hidden /> : null}
      {props.children}
    </button>
  );
}

export function Pill({ tone, children }: { tone: "ok" | "warn" | "bad" | "info" | "muted"; children: ReactNode }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Banner({ tone, children }: { tone: "ok" | "warn" | "bad" | "info"; children: ReactNode }) {
  return (
    <div className={`banner banner-${tone}`} role={tone === "bad" ? "alert" : "status"}>
      {children}
    </div>
  );
}

export function Json({ value, label }: { value: unknown; label?: string }) {
  return (
    <details className="json">
      <summary>{label ?? "Show raw JSON"}</summary>
      <pre>{JSON.stringify(value, null, 2)}</pre>
    </details>
  );
}

export function Card({ title, children, actions }: { title?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="card">
      {title ? (
        <header className="card-head">
          <h2>{title}</h2>
          {actions ? <div className="card-actions">{actions}</div> : null}
        </header>
      ) : null}
      {children}
    </section>
  );
}

export function KV({ rows }: { rows: [ReactNode, ReactNode][] }) {
  return (
    <dl className="kv">
      {rows.map(([k, v], i) => (
        <div key={i}>
          <dt>{k}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** The "guide for each step" panel. */
export function GuidePanel({ step }: { step: StepId }) {
  const g = guideFor(step);
  return (
    <aside className="guide" aria-label={`Guide: ${g.title}`}>
      <div className="guide-eyebrow">
        Step {g.n} · {g.who}
      </div>
      <h3>{g.title}</h3>
      <p className="guide-short">{g.short}</p>
      <h4>What happens</h4>
      <ul>
        {g.what.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <h4>What NEAR enforces</h4>
      <ul className="enforced">
        {g.enforced.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
      <h4>What to check</h4>
      <ul>
        {g.check.map((t) => (
          <li key={t}>{t}</li>
        ))}
      </ul>
    </aside>
  );
}

export function ErrorText({ error }: { error: string | null }) {
  return error ? <Banner tone="bad">{error}</Banner> : null;
}
