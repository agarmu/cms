import { config } from "./config";
import { createSession } from "./session";
import { CmsUserManager, oidcSettings } from "./oidc-settings";

const settings = config.auth;

export const auth =
    settings.kind === "oidc"
        ? new CmsUserManager(
              oidcSettings(settings, window.location.origin, sessionStorage),
          )
        : undefined;

export const {
    subscribeSession,
    getSession,
    initializeSession,
    invalidateSession,
    signIn,
    signOut,
} = createSession(auth, {
    currentUrl: () => new URL(window.location.href),
    replaceUrl: (url) =>
        window.history.replaceState(window.history.state, "", url),
    storage: sessionStorage,
});
