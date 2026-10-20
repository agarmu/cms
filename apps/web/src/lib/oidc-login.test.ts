import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
    InMemoryWebStorage,
    UserManager,
    type INavigator,
} from "oidc-client-ts";
import { CmsUserManager, oidcSettings } from "./oidc-settings";
import { createSession } from "./session";

test("OIDC login survives reload, renews expired tokens, and clears stored credentials on sign-out", async () => {
    const origin = "http://localhost:4321";
    const resource = "http://localhost:3000/";
    const clientId = "test-spa";
    const storage = new InMemoryWebStorage();
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-384" });
    let page = new URL(`${origin}/?offset=24&new=1`);
    let authorization: URL | undefined;
    let exchanges = 0;
    let refreshes = 0;
    let requestError: unknown;
    const jwt = (claims: object, type?: string) => {
        const header = Buffer.from(
            JSON.stringify({ alg: "ES384", ...(type ? { typ: type } : {}) }),
        ).toString("base64url");
        const payload = Buffer.from(JSON.stringify(claims)).toString(
            "base64url",
        );
        const input = `${header}.${payload}`;
        const signature = sign("sha384", Buffer.from(input), {
            key: privateKey,
            dsaEncoding: "ieee-p1363",
        }).toString("base64url");
        return `${input}.${signature}`;
    };
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request): Promise<Response> {
            const issuer = new URL("/oidc", server.url).href;
            const path = new URL(request.url).pathname;
            if (path === "/oidc/.well-known/openid-configuration")
                return Response.json({
                    issuer,
                    authorization_endpoint: `${issuer}/auth`,
                    token_endpoint: `${issuer}/token`,
                    jwks_uri: `${issuer}/jwks`,
                    response_types_supported: ["code"],
                    subject_types_supported: ["public"],
                    id_token_signing_alg_values_supported: ["ES384"],
                });
            if (path !== "/oidc/token")
                return new Response(null, { status: 404 });
            try {
                const body = new URLSearchParams(await request.text());
                expect(body.get("resource")).toBe(resource);
                expect(body.get("client_id")).toBe(clientId);
                expect(body.has("client_secret")).toBe(false);
                if (body.get("grant_type") === "authorization_code") {
                    exchanges++;
                    expect(body.get("code")).toBe("test-code");
                    expect(body.get("redirect_uri")).toBe(`${origin}/`);
                    const verifier = body.get("code_verifier")!;
                    expect(verifier.length).toBeGreaterThanOrEqual(43);
                    expect(
                        createHash("sha256")
                            .update(verifier)
                            .digest("base64url"),
                    ).toBe(authorization?.searchParams.get("code_challenge")!);
                } else {
                    refreshes++;
                    // Let the SDK's expiry timer fire while renewal is in flight.
                    await Bun.sleep(1500);
                    expect(body.get("grant_type")).toBe("refresh_token");
                    expect(body.get("refresh_token")).toBe(
                        "test-refresh-token",
                    );
                }
                const now = Math.floor(Date.now() / 1000);
                const claims = {
                    iss: issuer,
                    sub: "test-user",
                    iat: now,
                    exp: now + 3600,
                };
                return Response.json({
                    token_type: "Bearer",
                    expires_in: 3600,
                    scope: "openid offline_access photos:read",
                    access_token: jwt(
                        {
                            ...claims,
                            aud: resource,
                            client_id: clientId,
                            jti: crypto.randomUUID(),
                            scope: "photos:read",
                        },
                        "at+jwt",
                    ),
                    id_token: jwt({ ...claims, aud: clientId }),
                    refresh_token: "test-refresh-token",
                });
            } catch (error) {
                requestError = error;
                return Response.json(
                    { error: "invalid_request" },
                    { status: 400 },
                );
            }
        },
    });
    const navigator: INavigator = {
        async prepare() {
            return {
                async navigate({ url }) {
                    authorization = new URL(url);
                    return { url };
                },
                close() {},
            };
        },
        async callback() {},
    };
    const settings = {
        kind: "oidc" as const,
        issuer: new URL("/oidc", server.url).href,
        clientId,
        resource,
        scopes: ["openid", "offline_access", "photos:read"],
    };
    const managers: UserManager[] = [];
    const manager = () => {
        const instance = new CmsUserManager(
            oidcSettings(settings, origin, storage),
            navigator,
        );
        managers.push(instance);
        return instance;
    };
    const environment = {
        currentUrl: () => new URL(page),
        replaceUrl: (url: URL) => {
            page = url;
        },
        storage,
    };
    try {
        storage.setItem("cms.signed-out", "true");
        const initial = createSession(manager(), environment);
        await initial.initializeSession();
        expect((await initial.getSession()).ready).toBe(false);
        await initial.signIn();
        expect(authorization?.searchParams.get("resource")).toBe(resource);
        expect(authorization?.searchParams.get("response_type")).toBe("code");
        expect(authorization?.searchParams.get("code_challenge_method")).toBe(
            "S256",
        );
        expect(authorization?.searchParams.has("client_secret")).toBe(false);
        const callbackUrl = new URL(`${origin}/`);
        callbackUrl.searchParams.set("code", "test-code");
        callbackUrl.searchParams.set(
            "state",
            authorization!.searchParams.get("state")!,
        );
        page = callbackUrl;
        const callbackManager = manager();
        const session = createSession(callbackManager, environment);
        await session.initializeSession();
        if (requestError) throw requestError;
        expect((await session.getSession()).ready).toBe(true);
        expect(page.href).toBe(`${origin}/?offset=24&new=1`);
        expect(exchanges).toBe(1);
        const firstToken = (await callbackManager.getUser())!.access_token;
        callbackManager.stopSilentRenew();

        // A new document has a new manager and no access to the old one's memory.
        const reloadedManager = manager();
        const reloaded = createSession(reloadedManager, environment);
        await reloaded.initializeSession();
        expect((await reloaded.getSession()).ready).toBe(true);
        expect((await reloadedManager.getUser())!.access_token).toBe(
            firstToken,
        );
        expect(exchanges).toBe(1);
        expect(refreshes).toBe(0);

        // Reloading after token expiry must use the saved refresh token rather
        // than requiring an iframe login and third-party provider cookies.
        const expiredUser = (await reloadedManager.getUser())!;
        expiredUser.expires_at = Math.floor(Date.now() / 1000) - 10;
        reloadedManager.stopSilentRenew();
        await reloadedManager.storeUser(expiredUser);
        const renewedManager = manager();
        const renewed = createSession(renewedManager, environment);
        await renewed.initializeSession();
        if (requestError) throw requestError;
        expect((await renewed.getSession()).ready).toBe(true);
        expect(refreshes).toBe(1);
        expect((await renewedManager.getUser())!.access_token).not.toBe(
            firstToken,
        );
        expect(exchanges).toBe(1);

        await renewed.signOut();
        expect((await renewed.getSession()).ready).toBe(false);
        expect(await renewedManager.getUser()).toBeNull();
        expect(await manager().getUser()).toBeNull();
        for (let i = 0; i < storage.length; i++) {
            const value = storage.getItem(storage.key(i)!);
            expect(value).not.toContain("test-refresh-token");
            expect(value).not.toContain(firstToken);
        }
        expect(storage.getItem("cms.signed-out")).toBe("true");
        // The consumed state cannot be replayed in another document.
        page = callbackUrl;
        const replay = createSession(manager(), environment);
        await replay.initializeSession();
        expect((await replay.getSession()).ready).toBe(false);
        expect(page.search).toBe("");
        expect(exchanges).toBe(1);
    } finally {
        for (const instance of managers) {
            instance.stopSilentRenew();
            await instance.removeUser();
        }
        await server.stop(true);
    }
}, 15_000);
