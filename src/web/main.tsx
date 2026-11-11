import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { AccountBox } from "./components/Account";
import { Icon, type IconName } from "./components/icons";
import { PageLoading } from "./components/ui";
import { ContractPage } from "./pages/Contract";
import { ContractorSign } from "./pages/ContractorSign";
import { GuidePage } from "./pages/Guide";
import { Home } from "./pages/Home";
import { AgencyPage, MarketHome } from "./pages/Market";
import { NewContract } from "./pages/NewContract";
import { VerifyPage } from "./pages/Verify";
import { SessionProvider } from "./session";
import type { AppConfig } from "./types";

function useHashRoute() {
  const read = () => {
    const raw = window.location.hash.replace(/^#/, "") || "/";
    const [path = "/", query = ""] = raw.split("?");
    return { path, query: new URLSearchParams(query) };
  };
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}

function NavItem({ href, icon, label, active }: { href: string; icon: IconName; label: string; active: boolean }) {
  return (
    <a href={href} className={`nav-item${active ? " is-active" : ""}`}>
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </a>
  );
}

function Shell({ config, error }: { config: AppConfig | null; error: string | null }) {
  const { path, query } = useHashRoute();

  const m = path.match(/^\/c\/([\w-]+)(\/(sign|verify))?$/);
  const agency = path.match(/^\/market\/([\w-]+)$/);
  // Contractor-facing pages stand alone, without the company's app chrome.
  const standalone = !!m && (m[3] === "sign" || m[3] === "verify");

  let page: React.ReactNode;
  if (!config) page = error ? <div className="page"><p>Can't reach the server: {error}</p></div> : <PageLoading />;
  else if (path === "/new") page = <NewContract config={config} />;
  else if (path === "/guide") page = <GuidePage />;
  else if (path === "/market") page = <MarketHome config={config} />;
  else if (agency) page = <AgencyPage key={agency[1]} id={agency[1]!} config={config} />;
  else if (m && m[3] === "sign") page = <ContractorSign id={m[1]!} token={query.get("t")} config={config} />;
  else if (m && m[3] === "verify") page = <VerifyPage id={m[1]!} />;
  else if (m) page = <ContractPage key={m[1]} id={m[1]!} config={config} />;
  else page = <Home />;

  if (standalone)
    return (
      <div className="standalone">
        <header className="standalone-bar">
          <span className="brand">
            <span className="brand-mark">
              <Icon name="check" size={14} strokeWidth={2.6} />
            </span>
            Paperwork
          </span>
          <div className="row gap">
            {config?.platform === "fake" ? <span className="env-chip">Platform stand-in</span> : config?.stack ? <span className="env-chip">Local stack</span> : null}
            {config ? <AccountBox compact /> : null}
          </div>
        </header>
        {page}
      </div>
    );

  return (
    <div className="shell">
      <aside className="sidebar">
        <a href="#/" className="brand">
          <span className="brand-mark">
            <Icon name="check" size={14} strokeWidth={2.6} />
          </span>
          Paperwork
        </a>
        <nav className="nav">
          <NavItem href="#/" icon="grid" label="Jobs" active={path === "/" || (!!m && !standalone)} />
          <NavItem href="#/new" icon="plus" label="New job" active={path === "/new"} />
          {config?.market.enabled ? <NavItem href="#/market" icon="bot" label="Agent market" active={path.startsWith("/market")} /> : null}
          <NavItem href="#/guide" icon="book" label="How it works" active={path === "/guide"} />
        </nav>
        <div className="sidebar-foot">
          {config ? <AccountBox /> : null}
          {config?.platform === "fake" || config?.stack ? (
            <div className="env">
              <span className="env-dot" />
              <div>
                <strong>{config.stack ? "Local platform stack" : "Platform stand-in"}</strong>
                <span>No real funds · demo wallet</span>
              </div>
            </div>
          ) : config ? (
            <div className="env env-live">
              <span className="env-dot" />
              <div>
                <strong>MultiAgency platform</strong>
                <span>{config.host} · real funds</span>
              </div>
            </div>
          ) : null}
        </div>
      </aside>
      <main className="main">{page}</main>
    </div>
  );
}

function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    api<AppConfig>("GET", "/config").then(setConfig, (e: Error) => setError(e.message));
  }, []);
  if (!config) return <Shell config={null} error={error} />;
  return (
    <SessionProvider config={config}>
      <Shell config={config} error={null} />
    </SessionProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
