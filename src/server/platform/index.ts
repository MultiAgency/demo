import { SdkMarket } from "../market/sdk";
import { RpcChain, SimChain } from "./chain";
import { SdkPlatform, caFetch } from "./client";
import { FakePlatform } from "./fake";
import type { PlatformConfig, PlatformKit } from "./port";
import { KeySigner, stackSigner } from "./signer";
import { StackControls, readStack } from "./stack";

const MAINNET_RPC = "https://rpc.mainnet.fastnear.com";
const MARKET_URL = "https://market.near.ai";

/**
 * The platform Paperwork talks to.
 * - `fake`: the in-process stand-in (keyless demo, tests). One throwaway dev key signs for every account, like the
 *   stack's fixture key; the fake chain trusts it everywhere.
 * - `remote`: the MultiAgency platform through `@multiagency/sdk`. With `stackDir` (a local platform stack, dev only),
 *   URL, credential, CA and RPC come from its `state.json`, and controls plus the stack's fixture-key signer are given.
 *   Without it, `url` and `credential` are required and there are no controls and no dev signer.
 */
export function makePlatform(cfg: PlatformConfig): PlatformKit {
  if (cfg.mode === "fake") {
    const chain = new SimChain();
    const devSigner = KeySigner.random();
    chain.trustKey(devSigner.publicKey);
    const platform = new FakePlatform({ deployment: cfg.deployment, now: cfg.now, chain, autoSettle: cfg.autoSettle });
    return { platform, chain, controls: platform.controls, devSigner };
  }
  if (cfg.stackDir) {
    const stack = readStack(cfg.stackDir);
    if (cfg.deployment !== stack.deployment)
      throw new Error(`The platform stack serves app deployment "${stack.deployment}", but Paperwork is configured as "${cfg.deployment}"`);
    const send = caFetch(stack.caPem);
    const platform = new SdkPlatform({ url: stack.url, credential: stack.credential, deployment: stack.deployment, fetch: send, grantLabel: "invoices" });
    const controls = new StackControls(cfg.stackDir);
    // Without `--market` the stack sets up no market agents and serves no market: Paperwork shows no market then.
    const market = stack.marketUrl
      ? { platform: new SdkMarket({ url: stack.url, credential: stack.credential, deployment: stack.deployment, fetch: send }), controls, url: stack.marketUrl, rpcUrl: stack.rpcUrl, owner: stack.owner, dao: stack.dao }
      : null;
    return { platform, chain: new RpcChain(stack.rpcUrl), controls, devSigner: stackSigner(), market };
  }
  if (!cfg.url || !cfg.credential) throw new Error("PLATFORM=remote needs the platform URL and the app's service credential");
  const send = cfg.caPem ? caFetch(cfg.caPem) : undefined;
  const platform = new SdkPlatform({ url: cfg.url, credential: cfg.credential, deployment: cfg.deployment, ...(send && { fetch: send }) });
  const rpcUrl = cfg.rpcUrl ?? MAINNET_RPC;
  const market = { platform: new SdkMarket({ url: cfg.url, credential: cfg.credential, deployment: cfg.deployment, ...(send && { fetch: send }) }), controls: null, url: cfg.marketUrl ?? MARKET_URL, rpcUrl, owner: null, dao: null };
  return { platform, chain: new RpcChain(rpcUrl), controls: null, devSigner: null, market };
}
