import { expect, test } from "bun:test";
import { createConfig, lintFromString } from "@redocly/openapi-core";
import { drizzle } from "drizzle-orm/bun-sql";
import { requestApp, testAuthDependencies } from "../auth/test-fixtures";
import { NoAuthenticationProvider } from "../auth/no-auth";
import { DatabaseSchema } from "../db/schema";
import { HttpApplication } from "./app";

test.each(["bearer", "none"] as const)(
    "generated OpenAPI passes validation without warnings in %s mode",
    async (scheme) => {
        const errors: Error[] = [];
        const app = new HttpApplication({
            ...(scheme === "bearer"
                ? testAuthDependencies
                : {
                      authentication: new NoAuthenticationProvider(),
                      allowedSubjects: [NoAuthenticationProvider.subject],
                  }),
            db: drizzle.mock({ schema: DatabaseSchema.definition }),
            getImageStorage: () => {
                throw new Error("OpenAPI must not access image storage");
            },
            reportError: (error) => errors.push(error),
        });
        const response = await requestApp(app, "/openapi.json");
        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toContain(
            "application/json",
        );
        const problems = await lintFromString({
            source: await response.text(),
            config: await createConfig({ extends: ["minimal"] }),
        });
        expect(problems).toEqual([]);
        expect(errors).toEqual([]);
    },
    20_000,
);
