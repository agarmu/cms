import { expect, test } from "bun:test";
import { isDemoPath } from "./demo-mode";

test("only the demo page selects the demo client", () => {
    expect(isDemoPath("/demo")).toBe(true);
    expect(isDemoPath("/demo/")).toBe(true);
    for (const path of ["/", "/auth/silent", "/demo/other", "/demography"]) {
        expect(isDemoPath(path)).toBe(false);
    }
});

test.each(["/demo", "/demo/"])(
    "%s opens the demo without contacting or changing a configured OIDC session",
    async (pathname) => {
        // Use a separate browser-like environment so module-level route selection
        // cannot leak into the other session and CMS tests.
        const process = Bun.spawn(
            [
                Bun.which("bun")!,
                "--eval",
                `
        import { strict as assert } from "node:assert";
        globalThis.window = { location: { pathname: ${JSON.stringify(pathname)}, origin: "https://editor.example.com" } };
        globalThis.__CMS_CONFIG__ = {
            api: { baseUrl: "https://cms.example.com/" },
            auth: { kind: "oidc", issuer: "https://login.example.com/", clientId: "public-client", scopes: ["openid", "photos:read"] }
        };
        globalThis.sessionStorage = new Proxy({}, { get() { throw new Error("Demo must not access the real session"); } });
        const fixture = (await import(${JSON.stringify(new URL("./demo-test-fixtures.ts", import.meta.url).href)})).demoFixture();
        globalThis.fetch = (url, init) => fixture.fetcher(new URL(url), init);
        const session = await import(${JSON.stringify(new URL("./auth.ts", import.meta.url).href)});
        const { cms } = await import(${JSON.stringify(new URL("./api.ts", import.meta.url).href)});
        const { libraryUrl, createPhotoUrl } = await import(${JSON.stringify(new URL("./library-route.ts", import.meta.url).href)});
        assert.equal(session.auth, undefined);
        await session.initializeSession();
        assert.equal((await session.getSession()).ready, true);
        assert.equal((await cms.listPhotos(0, 25)).items.length, 25);
        assert.equal(libraryUrl(24), "/demo/?offset=24");
        assert.equal(createPhotoUrl(0), "/demo/?new=1");
        await session.signIn();
        await session.signOut();
        await session.invalidateSession();
    `,
            ],
            { stdout: "pipe", stderr: "pipe" },
        );
        const [exitCode, stderr] = await Promise.all([
            process.exited,
            new Response(process.stderr).text(),
        ]);
        expect(stderr).toBe("");
        expect(exitCode).toBe(0);
    },
);
