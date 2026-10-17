/// <reference types="bun" />
import { expect, test } from "bun:test";
import { createSession, type SessionManager } from "./session";

function fixture(initialUrl = "https://editor.example.com/") {
    let url = new URL(initialUrl);
    let user: Awaited<ReturnType<SessionManager["getUser"]>> = null;
    const storage = new Map<string, string>();
    const callbacks: Record<string, () => void> = {};
    const calls = {
        silent: 0,
        callback: 0,
        started: 0,
        stopped: 0,
        redirects: [] as string[],
    };
    let silentFailure = false;
    let callbackFailure = false;
    let returnTo = "/";
    const manager: SessionManager = {
        getUser: async () => user,
        removeUser: async () => {
            user = null;
            callbacks["unloaded"]?.();
        },
        clearStaleState: async () => {},
        signinSilent: async () => {
            calls.silent++;
            if (silentFailure) throw new Error("login_required");
            user = { expired: false };
            callbacks["loaded"]?.();
        },
        signinRedirect: async ({ state }) => {
            calls.redirects.push(state.returnTo);
        },
        signinRedirectCallback: async () => {
            calls.callback++;
            if (callbackFailure) throw new Error("Sign-in was denied.");
            user = { expired: false, state: { returnTo } };
            callbacks["loaded"]?.();
            return user;
        },
        startSilentRenew: () => {
            calls.started++;
        },
        stopSilentRenew: () => {
            calls.stopped++;
        },
        events: {
            addUserLoaded: (fn) => {
                callbacks["loaded"] = fn;
            },
            addUserUnloaded: (fn) => {
                callbacks["unloaded"] = fn;
            },
            addAccessTokenExpired: (fn) => {
                callbacks["expired"] = fn;
            },
            addSilentRenewError: (fn) => {
                callbacks["renewError"] = fn;
            },
        },
    };
    const environment = {
        currentUrl: () => new URL(url),
        replaceUrl: (next: URL) => {
            url = next;
        },
        storage: {
            getItem: (key: string) => storage.get(key) ?? null,
            setItem: (key: string, value: string) => {
                storage.set(key, value);
            },
            removeItem: (key: string) => {
                storage.delete(key);
            },
        },
    };
    return {
        session: createSession(manager, environment),
        manager,
        environment,
        calls,
        callbacks,
        get url() {
            return url;
        },
        set silentFailure(value: boolean) {
            silentFailure = value;
        },
        set callbackFailure(value: boolean) {
            callbackFailure = value;
        },
        set returnTo(value: string) {
            returnTo = value;
        },
    };
}

test("reload recovers the provider session once for concurrent consumers", async () => {
    const f = fixture();
    await Promise.all([
        f.session.initializeSession(),
        f.session.initializeSession(),
    ]);
    expect(f.calls.silent).toBe(1);
    expect((await f.session.getSession()).ready).toBe(true);
});

test("blocked silent login falls back to explicit sign-in and preserves the requested photo", async () => {
    const f = fixture("https://editor.example.com/?offset=24&photo=example");
    f.silentFailure = true;
    await f.session.initializeSession();
    expect(await f.session.getSession()).toEqual({
        ready: false,
        error: undefined,
    });
    await f.session.signIn();
    expect(f.calls.redirects).toEqual(["/?offset=24&photo=example"]);
});

test("OIDC callback restores the requested photo and removes callback parameters", async () => {
    const f = fixture(
        "https://editor.example.com/?code=temporary&state=nonce&iss=provider",
    );
    f.returnTo = "/?offset=24&photo=example";
    await f.session.initializeSession();
    expect(f.url.search).toBe("?offset=24&photo=example");
    expect(f.calls.callback).toBe(1);
    expect(f.calls.silent).toBe(0);
    expect(f.calls.started).toBe(1);
    expect((await f.session.getSession()).ready).toBe(true);
});

test("failed OIDC callbacks are cleaned up and expose a useful error", async () => {
    const f = fixture(
        "https://editor.example.com/?error=access_denied&state=nonce&error_description=denied",
    );
    f.callbackFailure = true;
    await f.session.initializeSession();
    expect(f.url.search).toBe("");
    expect(await f.session.getSession()).toEqual({
        ready: false,
        error: "Sign-in was denied.",
    });
});

test("callback state cannot redirect to another origin", async () => {
    const f = fixture("https://editor.example.com/?code=temporary&state=nonce");
    f.returnTo = "https://evil.example/?photo=private";
    await f.session.initializeSession();
    expect(f.url.href).toBe("https://editor.example.com/");
});

test("sign-out clears the user and suppresses silent login after reload", async () => {
    const f = fixture();
    await f.session.initializeSession();
    await f.session.signOut();
    expect((await f.session.getSession()).ready).toBe(false);
    expect(f.calls.stopped).toBe(1);
    const reloaded = createSession(f.manager, f.environment);
    await reloaded.initializeSession();
    expect(f.calls.silent).toBe(1);
    await reloaded.signIn();
    expect(f.environment.storage.getItem("cms.signed-out")).toBeNull();
});

test("expired tokens unload the session and notify consumers", async () => {
    const f = fixture();
    await f.session.initializeSession();
    let notifications = 0;
    f.session.subscribeSession(() => {
        notifications++;
    });
    f.callbacks["expired"]?.();
    await Promise.resolve();
    expect((await f.session.getSession()).ready).toBe(false);
    expect((await f.session.getSession()).error).toContain("session has ended");
    expect(notifications).toBe(1);
});

test("no-auth mode opens the library without provider or token storage access", async () => {
    const f = fixture();
    const session = createSession(undefined, f.environment);
    await session.initializeSession();
    expect(await session.getSession()).toEqual({
        ready: true,
        error: undefined,
    });
    expect(f.calls.silent).toBe(0);
});

test("rejected API credentials end the session with a sign-in message", async () => {
    const f = fixture();
    await f.session.initializeSession();
    await f.session.invalidateSession();
    expect(await f.session.getSession()).toEqual({
        ready: false,
        error: "Your session has ended. Sign in again to continue.",
    });
});
