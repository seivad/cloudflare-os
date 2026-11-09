// Which Google account a connection is for: pinned by its first connect, hinted to every later
// consent screen, and the only account a reconnect may sign in as.

import {env} from "cloudflare:workers";
import {runInDurableObject} from "cloudflare:test";
import {afterEach, describe, expect, it, vi} from "vitest";
import type {UserAccount} from "../../src/google";
import type {TestConnectCallback} from "./worker";

const testEnv = env as unknown as {UserAccount: DurableObjectNamespace<UserAccount>};

const REDIRECT = "https://os.example/gatekeeper/google/oauth";

type GoogleUser = {sub: string; email: string};
const ALICE: GoogleUser = {sub: "alice-sub", email: "alice@example.com"};
const BOB: GoogleUser = {sub: "bob-sub", email: "bob@example.com"};

type Account = UserAccount & {
  ctx: DurableObjectState & {
    exports: {TestConnectCallback(options: {props: object}): Fetcher<TestConnectCallback>};
  };
};

const json = (value: unknown) =>
  new Response(JSON.stringify(value), {headers: {"Content-Type": "application/json"}});

/** Google as each sign-in sees it: whoever `signIn` names gets the tokens; revocations are logged. */
function google() {
  const state = {signIn: ALICE, revoked: [] as string[]};
  vi.stubGlobal("fetch", async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.href === "https://oauth2.googleapis.com/token") {
      return json({
        access_token: `${state.signIn.sub}-token`, refresh_token: `${state.signIn.sub}-refresh`,
        expires_in: 3600, scope: "openid",
      });
    }
    if (url.href === "https://www.googleapis.com/oauth2/v3/userinfo") {
      const token = new Headers(init.headers).get("Authorization")?.replace(/^Bearer /, "");
      const user = [ALICE, BOB].find(candidate => `${candidate.sub}-token` === token);
      return user ? json(user) : new Response("unauthorized", {status: 401});
    }
    if (url.href === "https://oauth2.googleapis.com/revoke") {
      state.revoked.push(String(init.body));
      return new Response(null, {status: 200});
    }
    throw new Error(`unexpected request to ${url.href}`);
  });
  return state;
}

let counter = 0;
function account() {
  const stub = testEnv.UserAccount.get(testEnv.UserAccount.idFromName(`account-pinning-${++counter}`));
  return <T>(f: (account: Account, kv: SyncKvStorage) => Promise<T>) =>
    runInDurableObject(stub, (instance: UserAccount, state: DurableObjectState) =>
      f(instance as Account, state.storage.kv));
}

function nonce() {
  return [...crypto.getRandomValues(new Uint8Array(32))].map(b => b.toString(16).padStart(2, "0")).join("");
}

/** Runs one consent flow the way the gatekeeper's fetch handler does, through to its callback. */
async function consent(user: Account, mode: "connect" | "reconnect") {
  const initiation = nonce();
  if (mode === "connect") {
    await user.setCallback(user.ctx.exports.TestConnectCallback({props: {}}) as never, initiation, [], "connect");
  } else {
    await user.prepareReconnect(initiation, []);
  }
  const begun = await user.beginOAuthFlow(initiation, REDIRECT);
  if (!begun) throw new Error("the flow did not begin");
  return {loginHint: begun.loginHint, result: await user.acceptAuthCode("code", begun.oauthNonce)};
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google account pinning", () => {
  it("pins the account a first connect signs in as, and hints it to the next consent screen", async () => {
    google();
    const inAccount = account();
    await inAccount(async (user, kv) => {
      const first = await consent(user, "connect");
      expect(first.loginHint).toBeUndefined();
      expect(first.result).toEqual({handoff: {targetOrigin: "https://workshop.example", ticket: "connected"}});
      expect(kv.get("pinnedAccount")).toEqual(ALICE);

      const reconnect = await consent(user, "reconnect");
      expect(reconnect.loginHint).toBe(ALICE.sub);
      expect(reconnect.result).toMatchObject({handoff: {ticket: expect.stringMatching(/^reconnected:/)}});
    });
  });

  it("refuses a reconnect as another Google account, keeping and revoking nothing", async () => {
    const googleState = google();
    const inAccount = account();
    await inAccount(async (user, kv) => {
      await consent(user, "connect");
      googleState.signIn = BOB;

      const {result} = await consent(user, "reconnect");
      expect(result).toEqual({
        refused: {
          title: "That's a different Google account",
          detail: "This connection is for alice@example.com, but you signed in as bob@example.com. " +
              "Reconnect as alice@example.com, or connect bob@example.com as a separate account.",
        },
      });
      expect(kv.get("refreshToken")).toBe("alice-sub-refresh");
      expect(kv.get("pinnedAccount")).toEqual(ALICE);
      // Google revokes per user, so revoking Bob's new grant would sign out his own connections.
      expect(googleState.revoked).toEqual([]);
    });
  });

  it("pins an account connected before pinning existed once a reconnect commits", async () => {
    google();
    const inAccount = account();
    await inAccount(async (user, kv) => {
      kv.put("refreshToken", "legacy-refresh");
      kv.put("callback", user.ctx.exports.TestConnectCallback({props: {}}));
      const {loginHint, result} = await consent(user, "reconnect");
      expect(loginHint).toBeUndefined();
      expect(kv.get("pinnedAccount")).toBeUndefined();

      const ticket = result && "handoff" in result ? result.handoff.ticket : "";
      await user.commitReconnect(ticket.replace(/^reconnected:/, ""));
      expect(kv.get("pinnedAccount")).toEqual(ALICE);
      expect(kv.get("refreshToken")).toBe("alice-sub-refresh");
    });
  });
});
