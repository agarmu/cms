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
import { toOpenAPISchema } from "@elysiajs/openapi";
import type { AnyElysia } from "elysia";
import { z } from "zod";
import type { AuthenticationProvider } from "../auth/provider";

export class HttpOpenApi {
    static document(
        app: AnyElysia,
        scheme: AuthenticationProvider["scheme"] = "bearer",
    ) {
        const generated = toOpenAPISchema(app, undefined, undefined, {
            zod: (schema: z.ZodType) =>
                z.toJSONSchema(schema, {
                    io: "input",
                    unrepresentable: "any",
                    override: ({ zodSchema, jsonSchema }) => {
                        if (zodSchema instanceof z.ZodDate) {
                            jsonSchema.type = "string";
                            jsonSchema.format = "date-time";
                        }
                    },
                }),
        });
        // The generator assigns application/json even to empty and binary responses.
        for (const path of Object.values(generated.paths)) {
            for (const operation of [
                path?.get,
                path?.post,
                path?.patch,
                path?.delete,
            ]) {
                for (const [code, response] of Object.entries(
                    operation?.responses ?? {},
                )) {
                    if ("$ref" in response) continue;
                    if (code === "204") {
                        delete response.content;
                        continue;
                    }
                    const schema =
                        response.content?.["application/json"]?.schema;
                    if (!schema || "$ref" in schema || !schema.anyOf) continue;
                    const binary = schema.anyOf.find(
                        (part) => !("$ref" in part) && part.format === "binary",
                    );
                    if (!binary) continue;
                    response.content!["image/*"] = { schema: binary };
                    schema.anyOf = schema.anyOf.filter(
                        (part) => part !== binary,
                    );
                    if (schema.anyOf.length === 1)
                        response.content!["application/json"]!.schema =
                            schema.anyOf[0]!;
                }
            }
        }
        return {
            openapi: "3.1.2",
            info: { title: "Photos CMS", version: "1.0.0" },
            ...generated,
            servers: [{ url: "/" }],
            components: {
                ...generated.components,
                securitySchemes:
                    scheme === "none"
                        ? {}
                        : {
                              bearerAuth: {
                                  type: "http",
                                  scheme: "bearer",
                                  bearerFormat: "JWT",
                              },
                          },
            },
            security: scheme === "none" ? [] : [{ bearerAuth: [] }],
        };
    }
}
