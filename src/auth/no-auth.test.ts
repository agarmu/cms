import { expect, test } from "bun:test";
import { Scope } from "../api/scope";
import { NoAuthenticationProvider } from "./no-auth";
import { AuthenticationConfiguration } from "./config";

const provider = new NoAuthenticationProvider();

test("no-auth gives all requests the same owner and all scopes without shared mutable state", async () => {
    const first = await provider.authenticate();
    const second = await provider.authenticate("ignored");
    expect(provider.scheme).toBe("none");
    expect(first).toEqual({
        subject: NoAuthenticationProvider.subject,
        issuer: "urn:photos-cms:no-auth",
        scopes: new Set(Object.values(Scope)),
    });
    expect(second).toEqual(first);
    expect(second.scopes).not.toBe(first.scopes);
});

test("no-auth requires an explicit kind and rejects leftover provider settings", () => {
    expect(
        AuthenticationConfiguration.schema.parse({ kind: "no-auth" }),
    ).toEqual({ kind: "no-auth" });
    for (const settings of [
        {},
        { kind: "none" },
        { kind: "no-auth", issuer: "https://issuer.example.com" },
        { kind: "no-auth", allowedSubjects: ["someone"] },
    ]) {
        expect(
            AuthenticationConfiguration.schema.safeParse(settings).success,
        ).toBe(false);
    }
});
