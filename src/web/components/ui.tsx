import { type ReactNode, useState } from "react";
import { Icon, type IconName } from "./icons";

export function usd(v: string | number, opts: { cents?: boolean } = {}): string {
  const n = typeof v === "string" ? Number(v) : v;
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", minimumFractionDigits: opts.cents === false ? 0 : 2, maximumFractionDigits: 2 });
}

export function short(h: string, head = 6, tail = 4): string {
  return h.length > head + tail + 1 ? `${h.slice(0, head)}…${h.slice(-tail)}` : h;
}

export function dateText(iso: string | null | undefined, withTime = false): string {
  if (!iso) return "—";
  const d = new Date(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  return d.toLocaleString("en-US", { month: "short", day: "numeric", year: "numeric", ...(withTime ? { hour: "2-digit", minute: "2-digit" } : {}), timeZone: "UTC" });
}

export function timeText(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }) + " UTC";
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

export function Button(props: {
  children: ReactNode;
  onClick?: () => unknown | Promise<unknown>;
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  icon?: IconName;
  disabled?: boolean;
  type?: "button" | "submit";
  full?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type={props.type ?? "button"}
      className={`btn btn-${props.variant ?? "primary"} btn-${props.size ?? "md"}${props.full ? " btn-full" : ""}`}
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
      {busy ? <span className="spinner" aria-hidden /> : props.icon ? <Icon name={props.icon} /> : null}
      <span>{props.children}</span>
    </button>
  );
}

export function LinkButton({ href, children, variant = "secondary", icon, size = "md" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" | "ghost"; icon?: IconName; size?: "sm" | "md" }) {
  return (
    <a className={`btn btn-${variant} btn-${size}`} href={href}>
      {icon ? <Icon name={icon} /> : null}
      <span>{children}</span>
    </a>
  );
}

export type Tone = "success" | "warning" | "danger" | "info" | "neutral" | "accent";

export function Badge({ tone, children, dot }: { tone: Tone; children: ReactNode; dot?: boolean }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" /> : null}
      {children}
    </span>
  );
}

export function Alert({ tone, children, icon }: { tone: Exclude<Tone, "neutral" | "accent">; children: ReactNode; icon?: IconName }) {
  const def: IconName = tone === "success" ? "check" : tone === "danger" ? "alert" : tone === "warning" ? "alert" : "info";
  return (
    <div className={`alert alert-${tone}`} role={tone === "danger" ? "alert" : "status"}>
      <Icon name={icon ?? def} />
      <div>{children}</div>
    </div>
  );
}

export function Card({ children, className = "", pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
  return <section className={`card${pad ? " card-pad" : ""} ${className}`}>{children}</section>;
}

export function CardHeader({ title, sub, actions, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; icon?: IconName }) {
  return (
    <header className="card-header">
      <div className="card-title">
        {icon ? (
          <span className="icon-tile">
            <Icon name={icon} />
          </span>
        ) : null}
        <div>
          <h2>{title}</h2>
          {sub ? <p>{sub}</p> : null}
        </div>
      </div>
      {actions ? <div className="card-actions">{actions}</div> : null}
    </header>
  );
}

export function Stat({ label, value, sub, icon, children }: { label: string; value: ReactNode; sub?: ReactNode; icon?: IconName; children?: ReactNode }) {
  return (
    <div className="stat">
      <div className="stat-label">
        {icon ? <Icon name={icon} size={14} /> : null}
        {label}
      </div>
      <div className="stat-value">{value}</div>
      {children}
      {sub ? <div className="stat-sub">{sub}</div> : null}
    </div>
  );
}

export function Progress({ value, max, tone = "accent" }: { value: number; max: number; tone?: "accent" | "warning" | "danger" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
      <div className={`progress-bar progress-${tone}`} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Avatar({ name, tone = "neutral" }: { name: string; tone?: "neutral" | "accent" }) {
  return <span className={`avatar avatar-${tone}`}>{initials(name)}</span>;
}

export function Mono({ children, copy }: { children: string; copy?: string }) {
  const [copied, setCopied] = useState(false);
  if (!copy) return <code className="mono">{children}</code>;
  return (
    <button
      className="mono mono-copy"
      title="Copy"
      onClick={() => {
        navigator.clipboard?.writeText(copy).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => undefined,
        );
      }}
    >
      {children}
      <Icon name={copied ? "check" : "copy"} size={12} />
    </button>
  );
}

export function Disclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <details className="disclosure">
      <summary>
        <Icon name="chevronRight" size={14} />
        {label}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}

export function Json({ value, label = "Raw JSON" }: { value: unknown; label?: string }) {
  return (
    <Disclosure label={label}>
      <pre className="code">{JSON.stringify(value, null, 2)}</pre>
    </Disclosure>
  );
}

export function Tabs<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string; icon?: IconName; count?: number }[] }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.id} role="tab" aria-selected={value === t.id} className={`tab${value === t.id ? " is-active" : ""}`} onClick={() => onChange(t.id)}>
          {t.icon ? <Icon name={t.icon} size={15} /> : null}
          {t.label}
          {t.count ? <span className="tab-count">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

export function Empty({ icon, title, sub, action }: { icon: IconName; title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-icon">
        <Icon name={icon} size={22} />
      </span>
      <h3>{title}</h3>
      {sub ? <p>{sub}</p> : null}
      {action}
    </div>
  );
}

export function Spinner() {
  return <span className="spinner" aria-label="Loading" />;
}

export function PageLoading() {
  return (
    <div className="page-loading">
      <Spinner />
    </div>
  );
}
