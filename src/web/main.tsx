import { StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "./api";
import { ContractPage } from "./pages/Contract";
import { ContractorSign } from "./pages/ContractorSign";
import { GuidePage } from "./pages/Guide";
import { Home } from "./pages/Home";
import { NewContract } from "./pages/NewContract";
import { VerifyPage } from "./pages/Verify";
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

function App() {
  const { path, query } = useHashRoute();
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<AppConfig>("GET", "/config").then(setConfig, (e: Error) => setError(e.message));
  }, []);

  let page: React.ReactNode;
  const m = path.match(/^\/c\/([\w-]+)(\/(sign|verify))?$/);
  if (!config) page = error ? <p className="container">Can't reach the server: {error}</p> : <p className="container muted">Loading…</p>;
  else if (path === "/new") page = <NewContract />;
  else if (path === "/guide") page = <GuidePage />;
  else if (m && m[3] === "sign") page = <ContractorSign id={m[1]!} token={query.get("t")} config={config} />;
  else if (m && m[3] === "verify") page = <VerifyPage id={m[1]!} />;
  else if (m) page = <ContractPage key={m[1]} id={m[1]!} config={config} />;
  else page = <Home />;

  return (
    <>
      {config?.provider === "sim" ? (
        <div className="sim-strip" role="note">
          SIMULATED · no real funds, no network · the demo wallet signs for <code>acme.demo</code> and <code>maria.demo</code>
        </div>
      ) : null}
      <header className="topbar">
        <div className="container topbar-inner">
          <a href="#/" className="brand">
            <span className="logo" aria-hidden>
              ✓
            </span>
            Covenant
          </a>
          <nav>
            <a href="#/new">New contract</a>
            <a href="#/guide">Guide</a>
          </nav>
        </div>
      </header>
      <main>{page}</main>
      <footer className="footer">
        <div className="container">Covenant · the contract is the spending limit · built on the NEAR Intents Agent API · MIT</div>
      </footer>
    </>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
