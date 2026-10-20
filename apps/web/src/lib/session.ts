interface SessionUser {
    expired?: boolean | undefined;
    state?: unknown;
}

export interface SessionManager {
    getUser(): Promise<SessionUser | null>;
    removeUser(): Promise<void>;
    clearStaleState(): Promise<void>;
    signinSilent(): Promise<unknown>;
    signinRedirect(args: { state: { returnTo: string } }): Promise<void>;
    signinRedirectCallback(url: string): Promise<SessionUser>;
    startSilentRenew(): void;
    stopSilentRenew(): void;
    events: {
        addUserLoaded(callback: () => void): void;
        addUserUnloaded(callback: () => void): void;
        addAccessTokenExpired(callback: () => void): void;
        addSilentRenewError(callback: () => void): void;
    };
}

interface SessionEnvironment {
    currentUrl(): URL;
    replaceUrl(url: URL): void;
    storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export function createSession(
    manager: SessionManager | undefined,
    environment: SessionEnvironment,
) {
    const signedOutKey = "cms.signed-out";
    const listeners = new Set<() => void>();
    let initialization: Promise<void> | undefined;
    let initializing = true;
    let sessionError: string | undefined;
    let redirecting = false;
    const notify = () => {
        for (const listener of listeners) listener();
    };

    async function invalidateSession() {
        if (!manager) return;
        environment.storage.setItem(signedOutKey, "true");
        sessionError = "Your session has ended. Sign in again to continue.";
        manager.stopSilentRenew();
        await manager.removeUser();
    }

    manager?.events.addUserLoaded(() => {
        if (
            manager &&
            (redirecting || environment.storage.getItem(signedOutKey))
        ) {
            manager.stopSilentRenew();
            void manager.removeUser().catch(notify);
            return;
        }
        sessionError = undefined;
        notify();
    });
    manager?.events.addUserUnloaded(notify);
    manager?.events.addAccessTokenExpired(() => {
        // Startup may still be renewing an expired token loaded from storage.
        if (initializing) return;
        void invalidateSession().catch(() => notify());
    });
    manager?.events.addSilentRenewError(() => {
        sessionError = "Session renewal failed. You may need to sign in again.";
        notify();
    });

    async function completeSignIn() {
        const url = environment.currentUrl();
        if (
            !manager ||
            !url.searchParams.has("state") ||
            !(url.searchParams.has("code") || url.searchParams.has("error"))
        )
            return false;

        try {
            const user = await manager.signinRedirectCallback(url.href);
            if (environment.storage.getItem(signedOutKey)) {
                await manager.removeUser();
                return true;
            }
            const state = user.state as { returnTo?: unknown } | undefined;
            if (typeof state?.returnTo === "string") {
                const returnTo = new URL(state.returnTo, url.origin);
                if (
                    returnTo.origin === url.origin &&
                    returnTo.pathname === "/"
                ) {
                    url.search = returnTo.search;
                }
            }
            environment.storage.removeItem(signedOutKey);
            manager.startSilentRenew();
            return true;
        } finally {
            for (const key of [
                "code",
                "state",
                "error",
                "error_description",
                "error_uri",
                "iss",
                "session_state",
            ]) {
                url.searchParams.delete(key);
            }
            environment.replaceUrl(url);
        }
    }

    return {
        invalidateSession,
        subscribeSession(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        async getSession() {
            const user = await manager?.getUser();
            return {
                ready:
                    !manager ||
                    (!redirecting &&
                        !environment.storage.getItem(signedOutKey) &&
                        Boolean(user && !user.expired)),
                error: sessionError,
            };
        },
        initializeSession() {
            initialization ??= (async () => {
                if (!manager) return;
                try {
                    await manager.clearStaleState();
                    if (await completeSignIn()) return;
                    if (environment.storage.getItem(signedOutKey)) return;
                    const user = await manager.getUser();
                    if (user && !user.expired) return;
                    // Renew an expired stored token, or recover a provider session
                    // when this tab has no saved credentials.
                    try {
                        await manager.signinSilent();
                    } catch {
                        if (
                            user?.expired &&
                            !redirecting &&
                            !environment.storage.getItem(signedOutKey)
                        )
                            await invalidateSession();
                        // Blocked silent login falls back to explicit sign-in.
                    }
                } catch (error) {
                    sessionError =
                        error instanceof Error
                            ? error.message
                            : "Sign-in failed.";
                } finally {
                    initializing = false;
                }
            })();
            return initialization;
        },
        async signIn() {
            if (!manager) return;
            redirecting = true;
            manager.stopSilentRenew();
            environment.storage.removeItem(signedOutKey);
            const url = environment.currentUrl();
            try {
                await manager.signinRedirect({
                    state: { returnTo: url.pathname + url.search },
                });
            } catch (error) {
                redirecting = false;
                throw error;
            }
        },
        async signOut() {
            if (!manager) return;
            // Explicit sign-out must not be undone by silent session recovery.
            environment.storage.setItem(signedOutKey, "true");
            sessionError = undefined;
            manager.stopSilentRenew();
            await manager.removeUser();
        },
    };
}
