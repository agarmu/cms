export function isDemoPath(pathname: string) {
    return pathname === "/demo" || pathname === "/demo/";
}

export const demoMode =
    typeof window !== "undefined" && isDemoPath(window.location.pathname);
export const libraryHome = demoMode ? "/demo/" : "/";
