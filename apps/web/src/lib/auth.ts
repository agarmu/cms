import { config } from "./config";
import { createSession } from "./session";
import {
    InMemoryWebStorage,
    UserManager,
    WebStorageStateStore,
} from "oidc-client-ts";

const settings = config.auth;

export const auth =
    settings.kind === "oidc"
        ? new UserManager({
              authority: settings.issuer,
              client_id: settings.clientId,
              scope: settings.scopes.join(" "),
              response_type: "code",
              response_mode: "query",
              redirect_uri: new URL("/", window.location.origin).href,
              silent_redirect_uri: new URL(
                  "/auth/silent",
                  window.location.origin,
              ).href,
              ...(settings.resource ? { resource: settings.resource } : {}),
              extraQueryParams: settings.audience
                  ? { audience: settings.audience }
                  : {},
              loadUserInfo: false,
              // Only the redirect transaction (including its PKCE verifier) survives navigation.
              stateStore: new WebStorageStateStore({ store: sessionStorage }),
              userStore: new WebStorageStateStore({
                  store: new InMemoryWebStorage(),
              }),
              automaticSilentRenew: true,
              silentRequestTimeoutInSeconds: 10,
          })
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
