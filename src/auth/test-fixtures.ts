import { Scope } from "../api/scope";
import type { AuthenticationProvider, AuthIdentity } from "./provider";

export const testAuthSettings = {
    kind: "rfc-9068" as const,
    issuer: "https://issuer.example.com/",
    audience: "https://cms.example.com/",
    jwksUrl: "https://issuer.example.com/.well-known/jwks.json",
    allowedSubjects: ["test-user"],
};
export const testAuthIdentity: AuthIdentity = {
    subject: "test-user",
    issuer: testAuthSettings.issuer,
    scopes: new Set(Object.values(Scope)),
};
export const testAuthentication: AuthenticationProvider = {
    authenticate: async () => testAuthIdentity,
};
export const testAuthDependencies = {
    authentication: testAuthentication,
    allowedSubjects: testAuthSettings.allowedSubjects,
};
export const testAuthToml = `
[auth]
kind = "rfc-9068"
issuer = "${testAuthSettings.issuer}"
audience = "${testAuthSettings.audience}"
jwksUrl = "${testAuthSettings.jwksUrl}"
allowedSubjects = ["test-user"]
`;
