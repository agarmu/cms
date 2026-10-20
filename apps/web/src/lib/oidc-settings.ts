import {
    UserManager,
    WebStorageStateStore,
    type SigninSilentArgs,
    type UserManagerSettings,
} from "oidc-client-ts";
import type { ClientConfig } from "../../config";

export class CmsUserManager extends UserManager {
    override signinSilent(args: SigninSilentArgs = {}) {
        const resource = args.resource ?? this.settings.resource;
        return super.signinSilent({
            ...args,
            ...(resource ? { resource } : {}),
            extraTokenParams: {
                ...this.settings.extraTokenParams,
                ...(resource ? { resource } : {}),
                ...args.extraTokenParams,
            },
        });
    }
}

export function oidcSettings(
    settings: Extract<ClientConfig["auth"], { kind: "oidc" }>,
    origin: string,
    storage: Storage,
): UserManagerSettings {
    return {
        authority: settings.issuer,
        client_id: settings.clientId,
        scope: settings.scopes.join(" "),
        response_type: "code",
        response_mode: "query",
        redirect_uri: new URL("/", origin).href,
        silent_redirect_uri: new URL("/auth/silent", origin).href,
        ...(settings.resource
            ? {
                  resource: settings.resource,
                  // Preserve API resource selection during exchange and renewal.
                  extraTokenParams: { resource: settings.resource },
              }
            : {}),
        extraQueryParams: settings.audience
            ? { audience: settings.audience }
            : {},
        loadUserInfo: false,
        // Tab-scoped storage preserves login across reloads without relying on
        // a third-party iframe to recover the provider session.
        stateStore: new WebStorageStateStore({ store: storage }),
        userStore: new WebStorageStateStore({ store: storage }),
        automaticSilentRenew: true,
        silentRequestTimeoutInSeconds: 10,
    };
}
