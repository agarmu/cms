import { config } from "./config";
import { auth, invalidateSession } from "./auth";
import { ApiError, CmsClient } from "./cms-client";

export const cms = new CmsClient(
    config.api.baseUrl,
    async () => {
        const user = await auth?.getUser();
        if (auth && (!user || user.expired)) {
            throw new ApiError(401, "Sign in to view your photo library.");
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
