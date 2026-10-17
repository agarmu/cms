import { z } from "zod";

const publicUrl = z.url().refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return (
        (url.protocol === "https:" ||
            (url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
        !url.username &&
        !url.password &&
        !url.hash &&
        !url.search
    );
});

export type ApplicationSettings = z.input<typeof ApplicationConfig.schema>;
export type ClientConfig = z.output<typeof ApplicationConfig.schema>;

export class ApplicationConfig {
    static readonly schema = z.strictObject({
        api: z.strictObject({
            baseUrl: publicUrl.refine(
                (value) =>
                    URL.canParse(value) && new URL(value).pathname === "/",
            ),
        }),
        auth: z.discriminatedUnion("kind", [
            z.strictObject({ kind: z.literal("no-auth") }),
            z.strictObject({
                kind: z.literal("oidc"),
                issuer: publicUrl,
                clientId: z.string().trim().min(1),
                scopes: z
                    .array(z.string().trim().min(1).regex(/^\S+$/))
                    .refine((scopes) => scopes.includes("openid"))
                    .default(["openid", "photos:read"]),
                resource: z.string().min(1).optional(),
                audience: z.string().min(1).optional(),
            }),
        ]),
    });

    readonly api: Readonly<ClientConfig["api"]>;
    readonly auth: Readonly<ClientConfig["auth"]>;

    constructor(values: ApplicationSettings) {
        const result = ApplicationConfig.schema.safeParse(values);
        if (!result.success) throw new Error("Invalid configuration settings");
        this.api = Object.freeze(result.data.api);
        this.auth = Object.freeze(result.data.auth);
    }

    static async fromFile(configPath: string | URL = "config.toml") {
        let text: string;
        try {
            text = await Bun.file(configPath).text();
        } catch {
            throw new Error("Cannot read configuration file: " + configPath);
        }
        let values: unknown;
        try {
            values = Bun.TOML.parse(text);
        } catch {
            throw new Error("Invalid TOML configuration file: " + configPath);
        }
        return new ApplicationConfig(values as ApplicationSettings);
    }
}
