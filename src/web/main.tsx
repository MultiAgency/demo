import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { AccountBox } from "./components/Account";
import { BrandMark } from "./components/BrandMark";
import { Icon, type IconName } from "./components/icons";
import { Empty, PageLoading } from "./components/ui";
import { ContractPage } from "./pages/Contract";
import { ContractorSign } from "./pages/ContractorSign";
import { GuidePage } from "./pages/Guide";
import { Home } from "./pages/Home";
import { JobsPage } from "./pages/Jobs";
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

function NavItem({ href, icon, label, shortLabel, active }: { href: string; icon: IconName; label: string; shortLabel: string; active: boolean }) {
  return (
    <a href={href} data-short-label={shortLabel} className={`nav-item${active ? " is-active" : ""}`} aria-current={active ? "page" : undefined} aria-label={label} title={label}>
      <Icon name={icon} size={17} />
      <span>{label}</span>
    </a>
  );
}

function SkipLink() {
  return <a className="skip-link" href="#main" onClick={(event) => { event.preventDefault(); document.getElementById("main")?.focus(); }}>Skip to content</a>;
}

function Shell({ config, error }: { config: AppConfig | null; error: string | null }) {
  const { path, query } = useHashRoute();
  useEffect(() => {
    document.title = "Paperwork";
    const main = document.getElementById("main");
    if (!main) return;
    let done = false;
    const focusHeading = () => {
      const heading = main.querySelector<HTMLElement>("h1");
      if (!heading || done) return;
      done = true;
      heading.tabIndex = -1;
      heading.focus({ preventScroll: true });
      // Browser titles must not retain private party names after a session changes on the same route.
      const title = path.startsWith("/c/") ? path.endsWith("/verify") ? "Verification status" : path.endsWith("/sign") ? "Builder job" : "Agency job"
        : path.startsWith("/market/") ? "Market agency" : heading.textContent;
      document.title = `${title} · Paperwork`;
      observer.disconnect();
    };
    const observer = new MutationObserver(focusHeading);
    observer.observe(main, { childList: true, subtree: true });
    main.focus({ preventScroll: true });
    focusHeading();
    return () => observer.disconnect();
  }, [path]);

  const m = path.match(/^\/c\/([\w-]+)(\/(sign|verify))?$/);
  const agency = path.match(/^\/market\/([\w-]+)$/);
  // Contractor-facing pages stand alone, without the company's app chrome.
  const standalone = !!m && (m[3] === "sign" || m[3] === "verify");

  let page: React.ReactNode;
  if (!config) page = error ? <div className="page"><p>Can't reach the server: {error}</p></div> : <PageLoading />;
  else if (path === "/" || path === "/my-jobs") page = <JobsPage config={config} view="my-jobs" />;
  else if (path === "/agency") page = <Home />;
  else if (path === "/openings") page = <JobsPage config={config} view="openings" />;
  else if (path === "/market-jobs") page = <JobsPage config={config} view="market" />;
  else if (path === "/assignments") page = <JobsPage config={config} view="assignments" />;
  else if (path === "/start") page = <JobsPage config={config} view="start" />;
  else if (path === "/new") page = <NewContract config={config} />;
  else if (path === "/guide") page = <GuidePage />;
  else if (path === "/market") page = <MarketHome config={config} />;
  else if (agency) page = <AgencyPage key={agency[1]} id={agency[1]!} config={config} />;
  else if (m && m[3] === "sign") page = <ContractorSign id={m[1]!} token={query.get("t")} config={config} />;
  else if (m && m[3] === "verify") page = <VerifyPage id={m[1]!} />;
  else if (m) page = <ContractPage key={m[1]} id={m[1]!} config={config} />;
  else page = <div className="page"><h1>Page not found</h1><Empty icon="file" title="This page is unavailable" sub="Check the link, or return to your existing jobs." action={<a className="btn btn-primary btn-sm" href="#/">Assigned to me</a>} /></div>;

  if (standalone)
    return (
      <div className="standalone">
        <SkipLink />
        <header className="standalone-bar">
          <span className="brand">
            <BrandMark />
            Paperwork
          </span>
          <div className="row gap">
            {config?.platform === "fake" ? <span className="env-chip">Platform stand-in</span> : config?.stack ? <span className="env-chip">Local stack</span> : null}
            {config ? <AccountBox compact /> : null}
          </div>
        </header>
        <main id="main" tabIndex={-1}>{page}</main>
      </div>
    );

  return (
    <div className="shell">
      {/* Routes live in the hash, so the skip link moves focus rather than navigating. */}
      <SkipLink />
      <aside className="sidebar">
        <a href="#/" className="brand">
          <BrandMark />
          Paperwork
        </a>
        <nav className="nav">
          <NavItem href="#/" icon="grid" label="Assigned to me" shortLabel="My jobs" active={path === "/" || path === "/my-jobs"} />
          <NavItem href="#/agency" icon="building" label="Agency" shortLabel="Agency" active={path === "/agency" || path === "/new" || path === "/market" || path === "/assignments" || !!agency || (!!m && !standalone)} />
          <NavItem href="#/openings" icon="file" label="Openings" shortLabel="Openings" active={path === "/openings" || path === "/market-jobs"} />
          <NavItem href="#/start" icon="plus" label="Get started" shortLabel="Start" active={path === "/start"} />
          <NavItem href="#/guide" icon="book" label="How it works" shortLabel="Guide" active={path === "/guide"} />
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
      <main className="main" id="main" tabIndex={-1}>{page}</main>
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
