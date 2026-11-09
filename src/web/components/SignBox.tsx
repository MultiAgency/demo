import { canDemoSign } from "../api";
import type { AppConfig, SignRequest } from "../types";
import { Icon } from "./icons";
import { Button, Disclosure, Mono } from "./ui";

/**
 * One NEP-413 signature the representative has to give. With demo controls the demo wallet signs on click;
 * otherwise the message is shown to sign in the account's own wallet.
 */
export function SignBox({ config, req, label, onSign }: { config: AppConfig; req: SignRequest; label: string; onSign: () => Promise<unknown> }) {
  if (canDemoSign(config))
    return (
      <div className="check-action col">
        <Disclosure label="Message to sign">
          <code className="mono sign-msg">{req.message}</code>
          <div className="kv-line">
            <span>Recipient</span>
            <Mono>{req.recipient}</Mono>
          </div>
        </Disclosure>
        <Button icon="pen" onClick={onSign}>
          {label} (demo wallet signs as {req.account_id})
        </Button>
      </div>
    );
  return (
    <div className="check-action col">
      <span className="muted small">
        Sign this message as <strong>{req.account_id}</strong> with your NEAR wallet (NEP-413, recipient <code>{req.recipient}</code>).
      </span>
      <code className="mono sign-msg">{req.message}</code>
    </div>
  );
}

/** A step signed on the platform's own confirm page. */
export function ConfirmLink({ config, url, expiresAt, onDemoComplete }: { config: AppConfig; url: string; expiresAt: string; onDemoComplete: () => Promise<unknown> }) {
  return (
    <div className="check-action">
      <a className="btn btn-primary btn-md" href={url} target="_blank" rel="noreferrer">
        <Icon name="external" /> <span>Open the platform's confirm page</span>
      </a>
      <span className="muted small">Link expires {new Date(expiresAt).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", timeZone: "UTC" })} UTC</span>
      {config.demo_controls ? (
        <Button variant="secondary" size="sm" onClick={onDemoComplete}>
          Confirm (demo)
        </Button>
      ) : null}
    </div>
  );
}
