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
//
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
            config: await createConfig({
                extends: ["recommended-strict"],
            }),
        });
        expect(problems).toEqual([]);
        expect(errors).toEqual([]);
    },
    20_000,
);
