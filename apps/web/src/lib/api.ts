import { config } from "./config";
import { auth, invalidateSession, subscribeSession } from "./auth";
import { ApiError, CmsClient, type LibraryClient } from "./cms-client";
import { demoMode } from "./demo-mode";

export const cms: LibraryClient = demoMode
    ? new (await import("./demo-client")).DemoClient(
          new CmsClient(
              config.api.baseUrl,
              async () => undefined,
              async (url, init) => {
                  if (
                      !["GET", "HEAD"].includes(
                          (init.method ?? "GET").toUpperCase(),
                      )
                  )
                      throw new Error("The demo API is read-only.");
                  return fetch(url, init);
              },
              async () => {
                  throw new Error("Demo uploads must stay in the browser.");
              },
              "/api/demo",
          ),
      )
    : new CmsClient(
          config.api.baseUrl,
          async () => {
              const user = await auth?.getUser();
              if (auth && (!user || user.expired)) {
                  throw new ApiError(
                      401,
                      "Sign in to view your photo library.",
                  );
              }
              return user?.access_token;
          },
          async (url, init) => {
              const response = await fetch(url, init);
              if (response.status === 401) {
                  if (auth) await invalidateSession();
                  else
                      throw new ApiError(
                          401,
                          "The CMS requires authentication. Check the frontend authentication settings.",
                      );
              }
              return response;
          },
      );

subscribeSession(() => cms.clearCache());
