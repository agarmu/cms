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
import { DatabaseConnection } from "../db/connection";
import type { DatabaseSession } from "../db/connection";
import type { BlobStorage } from "../services/blob-storage";
import { Tracing } from "../telemetry/tracing";
import type { ApplicationConfig } from "./config";
import { Application } from "./index";
import { StorageFactory } from "./storage";
import type { AuthenticationProvider } from "../auth/provider";
import { Rfc9068AuthenticationProvider } from "../auth/rfc-9068";
import { NoAuthenticationProvider } from "../auth/no-auth";
import { removeStaleSocket } from "./unix-socket";

export type RuntimeDependencies = {
    authentication?: AuthenticationProvider;
    connect?: (options: Bun.SQL.Options) => Promise<DatabaseSession>;
    getBlobStorage?: () => BlobStorage;
    reportError?: (error: Error) => void;
};

export class ApplicationRuntime {
    private connection: DatabaseSession | undefined;
    private application: Application | undefined;
    private server: ReturnType<typeof Bun.serve> | undefined;
    private starting: Promise<this> | undefined;
    private stopping: Promise<void> | undefined;
    private releasing: Promise<void> | undefined;

    constructor(
        private readonly config: ApplicationConfig,
        private readonly options: RuntimeDependencies = {},
    ) {}

    get url() {
        if (!this.server) throw new Error("Application has not started");
        return this.server.url;
    }

    start(): Promise<this> {
        if (this.stopping || this.releasing)
            return Promise.reject(new Error("Application has stopped"));
        return (this.starting ??= this.initialize());
    }

    private async initialize() {
        try {
            await Tracing.withSpan("runtime.startup", async () => {
                this.connection = await (
                    this.options.connect ?? DatabaseConnection.open
                )(this.config.database.clientOptions());
                const factory = new StorageFactory(
                    this.config.storage,
                    this.config.baseUrl
                        ? {
                              baseUrl: this.config.baseUrl,
                              maxBytes: this.config.images.maxBytes,
                          }
                        : undefined,
                );
                this.application = new Application({
                    authentication:
                        this.options.authentication ??
                        (this.config.auth.kind === "no-auth"
                            ? new NoAuthenticationProvider()
                            : new Rfc9068AuthenticationProvider(
                                  this.config.auth,
                                  this.config.baseUrl!,
                              )),
                    allowedSubjects:
                        this.config.auth.kind === "no-auth"
                            ? [NoAuthenticationProvider.subject]
                            : this.config.auth.allowedSubjects,
                    db: this.connection.db,
                    getBlobStorage:
                        this.options.getBlobStorage ?? (() => factory.create()),
                    reportError:
                        this.options.reportError ??
                        ((error) => console.error(error)),
                    imageConfig: this.config.images,
                    workerConfig: this.config.workers,
                    httpConfig: this.config.http,
                    mcpConfig: this.config.mcp,
                });
                this.server = await Tracing.withSpan(
                    "http.server.start",
                    async () => {
                        const serve = () =>
                            Bun.serve({
                                maxRequestBodySize: Math.max(
                                    this.config.images.mcpMaxBodyBytes,
                                    this.config.http.maxBodyBytes,
                                ),
                                ...(this.config.unix
                                    ? { unix: this.config.unix }
                                    : {
                                          port: this.config.port,
                                          hostname: this.config.hostname,
                                      }),
                                fetch: this.application!.http.fetch,
                            });
                        try {
                            return serve();
                        } catch (error) {
                            if (
                                !this.config.unix ||
                                !(error instanceof Error) ||
                                !("code" in error) ||
                                error.code !== "EADDRINUSE" ||
                                !(await removeStaleSocket(this.config.unix))
                            )
                                throw error;
                            return serve();
                        }
                    },
                );
                this.application.start();
            });
            return this;
        } catch (error) {
            try {
                await this.release();
            } catch (cleanupError) {
                throw new AggregateError(
                    [error, cleanupError],
                    "Application startup and cleanup failed",
                );
            }
            throw error;
        }
    }

    stop() {
        return (this.stopping ??= (async () => {
            // A stop requested during startup must also release resources opened later.
            try {
                await this.starting;
            } catch {
                /* Startup reports its own failure. */
            }
            await this.release();
        })());
    }

    private release() {
        return (this.releasing ??= Tracing.withSpan(
            "runtime.shutdown",
            async () => {
                try {
                    if (this.server)
                        await Tracing.withSpan("http.server.stop", () =>
                            this.server!.stop(),
                        );
                } finally {
                    try {
                        await this.application?.stop();
                    } finally {
                        await this.connection?.close();
                    }
                }
            },
        ));
    }
}
