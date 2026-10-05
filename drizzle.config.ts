import { defineConfig } from "drizzle-kit";

export default defineConfig({
    dialect: "postgresql",
    schema: "./src/db/migration-schema.ts",
    out: "./migrations",
});
