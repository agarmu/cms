// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { Scope } from "../api/scope";
import { AuthenticationConfiguration } from "./config";
import { Rfc9068AuthenticationProvider } from "./rfc-9068";
import {
    AuthenticationError,
    AuthenticationUnavailableError,
} from "./provider";
import { testAuthSettings } from "./test-fixtures";

const key = await generateKeyPair("ES256");
const jwk = {
    ...(await exportJWK(key.publicKey)),
    kid: "test",
    alg: "ES256",
    use: "sig",
};
let server: ReturnType<typeof Bun.serve>;
let requests = 0;
let provider: Rfc9068AuthenticationProvider;

beforeAll(() => {
    server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => {
            requests++;
            return Response.json({ keys: [jwk] });
        },
    });
    provider = new Rfc9068AuthenticationProvider(
        AuthenticationConfiguration.rfc9068.parse({
            ...testAuthSettings,
            jwksUrl: server.url.href,
        }),
    );
});
afterAll(() => server?.stop(true));

function token(
    claims: Record<string, unknown> = {},
    signingKey = key.privateKey,
    header = { alg: "ES256", kid: "test", typ: "at+jwt" },
) {
    const now = Math.floor(Date.now() / 1000);
    return new SignJWT({
        iss: testAuthSettings.issuer,
        aud: testAuthSettings.audience,
        sub: "test-user",
        iat: now,
        exp: now + 300,
        client_id: "test-client",
        jti: crypto.randomUUID(),
        scope: "photos:read",
        ...claims,
    })
        .setProtectedHeader(header)
        .sign(signingKey);
}

test("verifies access tokens through remote JWKS and caches the keys", async () => {
    const accessToken = await token({
        scope: "openid photos:read photos:read made-up:write",
        permissions: ["photos:create"],
    });
    const identity = await provider.authenticate(accessToken);
    expect(identity).toEqual({
        subject: "test-user",
        issuer: testAuthSettings.issuer,
        scopes: new Set([Scope.PhotosRead]),
    });
    const fetched = requests;
    expect(fetched).toBeGreaterThan(0);
    await provider.authenticate(accessToken);
    expect(requests).toBe(fetched);
});

test.each([
    { iss: "https://other.example.com/" },
    { iss: testAuthSettings.issuer.slice(0, -1) },
    { aud: "some-browser-client-id" },
    { aud: [testAuthSettings.audience, 123] },
    { exp: 1 },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
    { sub: "" },
    { sub: undefined },
    { exp: undefined },
    { iat: undefined },
    { client_id: undefined },
    { client_id: 123 },
    { client_id: "" },
    { jti: undefined },
    { jti: "" },
    { scope: ["photos:read"] },
    { scope: "photos:read\tphotos:create" },
])("rejects invalid token claims (%#)", async (claims) => {
    await expect(
        provider.authenticate(await token(claims)),
    ).rejects.toBeInstanceOf(AuthenticationError);
});

test("accepts audience arrays and grants no scopes when the claim is absent", async () => {
    const identity = await provider.authenticate(
        await token({
            aud: ["https://other.example.com", testAuthSettings.audience],
            scope: undefined,
        }),
    );
    expect(identity.scopes.size).toBe(0);
});

test("accepts only the configured algorithm even when JWKS publishes both key types", async () => {
    const rsaKey = await generateKeyPair("RS256");
    const jwks = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => Response.json({ keys: [jwk, rsaJwk] }),
    });
    const rsaJwk = {
        ...(await exportJWK(rsaKey.publicKey)),
        kid: "rsa",
        alg: "RS256",
        use: "sig",
    };
    try {
        const tokens = {
            ES256: await token(),
            RS256: await token({}, rsaKey.privateKey, {
                alg: "RS256",
                kid: "rsa",
                typ: "at+jwt",
            }),
        };
        for (const algorithm of ["ES256", "RS256"] as const) {
            const auth = new Rfc9068AuthenticationProvider({
                ...testAuthSettings,
                algorithm,
                jwksUrl: jwks.url.href,
            });
            expect(await auth.authenticate(tokens[algorithm])).toEqual({
                subject: "test-user",
                issuer: testAuthSettings.issuer,
                scopes: new Set([Scope.PhotosRead]),
            });
            const other = algorithm === "ES256" ? "RS256" : "ES256";
            await expect(
                auth.authenticate(tokens[other]),
            ).rejects.toBeInstanceOf(AuthenticationError);
        }
    } finally {
        jwks.stop(true);
    }
});

test("rejects forged signatures, unknown keys, and disallowed algorithms", async () => {
    const wrongKey = await generateKeyPair("ES256");
    await expect(
        provider.authenticate(await token({}, wrongKey.privateKey)),
    ).rejects.toBeInstanceOf(AuthenticationError);
    await expect(
        provider.authenticate(
            await token({}, key.privateKey, {
                alg: "ES256",
                kid: "unknown",
                typ: "at+jwt",
            }),
        ),
    ).rejects.toBeInstanceOf(AuthenticationError);
    const rsaKey = await generateKeyPair("RS256");
    await expect(
        provider.authenticate(
            await token({}, rsaKey.privateKey, {
                alg: "RS256",
                kid: "test",
                typ: "at+jwt",
            }),
        ),
    ).rejects.toBeInstanceOf(AuthenticationError);
    const symmetric = await new SignJWT({ sub: "test-user" })
        .setProtectedHeader({ alg: "HS256" })
        .sign(new Uint8Array(32));
    await expect(provider.authenticate(symmetric)).rejects.toBeInstanceOf(
        AuthenticationError,
    );
});

test("requires the access-token type and accepts its full media type", async () => {
    for (const typ of ["JWT", "", "id+jwt"]) {
        await expect(
            provider.authenticate(
                await token({}, key.privateKey, {
                    alg: "ES256",
                    kid: "test",
                    typ,
                }),
            ),
        ).rejects.toBeInstanceOf(AuthenticationError);
    }
    const identity = await provider.authenticate(
        await token({}, key.privateKey, {
            alg: "ES256",
            kid: "test",
            typ: "application/at+jwt",
        }),
    );
    expect(identity.subject).toBe("test-user");
});

test("rejects malformed tokens", async () => {
    await expect(provider.authenticate("not-a-jwt")).rejects.toBeInstanceOf(
        AuthenticationError,
    );
});

test.each(["unavailable", "invalid-json", "invalid-jwks"])(
    "fails closed when JWKS is %s",
    async (mode) => {
        const failing = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch: () =>
                mode === "unavailable"
                    ? new Response("private provider error", { status: 503 })
                    : mode === "invalid-json"
                      ? new Response("private provider error")
                      : Response.json({ keys: "bad" }),
        });
        try {
            const auth = new Rfc9068AuthenticationProvider(
                AuthenticationConfiguration.rfc9068.parse({
                    ...testAuthSettings,
                    jwksUrl: failing.url.href,
                }),
            );
            await expect(
                auth.authenticate(await token()),
            ).rejects.toBeInstanceOf(AuthenticationUnavailableError);
        } finally {
            await failing.stop(true);
        }
    },
);

test("rejects unsupported or insecure settings", () => {
    for (const settings of [
        { ...testAuthSettings, issuer: "not a url" },
        { ...testAuthSettings, jwksUrl: "not a url" },
        { ...testAuthSettings, kind: "none" },
        { ...testAuthSettings, algorithm: "HS256" },
        { ...testAuthSettings, algorithm: "ES384" },
        { ...testAuthSettings, issuer: "http://issuer.example.com/" },
        {
            ...testAuthSettings,
            jwksUrl: "https://user:secret@issuer.example.com/keys",
        },
        {
            ...testAuthSettings,
            issuer: "https://issuer.example.com/?tenant=value",
        },
        { ...testAuthSettings, allowedSubjects: [] },
    ])
        expect(
            AuthenticationConfiguration.schema.safeParse(settings).success,
        ).toBe(false);
});

test("allows query parameters on JWKS endpoints", () => {
    expect(
        AuthenticationConfiguration.schema.safeParse({
            ...testAuthSettings,
            jwksUrl: "https://issuer.example.com/keys?tenant=cms",
        }).success,
    ).toBe(true);
});

test("RFC 9068 rejects missing tokens without requesting JWKS", async () => {
    const before = requests;
    await expect(provider.authenticate()).rejects.toBeInstanceOf(
        AuthenticationError,
    );
    expect(requests).toBe(before);
});
