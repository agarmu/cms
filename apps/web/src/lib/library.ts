import { cms } from "./api";
import { getSession, initializeSession, subscribeSession } from "./auth";
import {
    ApiError,
    selectAsset,
    type Photo,
    type PhotoAsset,
} from "./cms-client";
import { libraryUrl, pageSize, readRoute } from "./library-route";
import { PhotoLightbox } from "./photo-lightbox";

function element<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing library element: ${selector}`);
    return found;
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timestampFormat = new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
});

function renderVisibility(marker: HTMLElement, enabled: boolean) {
    const label = enabled ? "Visible" : "Hidden";
    marker.setAttribute("aria-label", label);
    marker.title = label;
    marker.hidden = false;
    element(marker, "[data-visible-icon]").hidden = !enabled;
    element(marker, "[data-hidden-icon]").hidden = enabled;
}

export function mountLibrary(root: HTMLElement) {
    const status = element(root, "[data-library-status]");
    const statusTitle = element(root, "[data-status-title]");
    const statusDescription = element(root, "[data-status-description]");
    const retry = element<HTMLButtonElement>(root, "[data-retry]");
    const statusBack = element<HTMLAnchorElement>(root, "[data-status-back]");
    const list = element(root, "[data-library-view]");
    const detail = element(root, "[data-photo-view]");
    const grid = element(root, "[data-photo-grid]");
    const template = element<HTMLTemplateElement>(root, "[data-photo-card]");
    const previous = element<HTMLAnchorElement>(root, "[data-previous]");
    const next = element<HTMLAnchorElement>(root, "[data-next]");
    const back = element<HTMLAnchorElement>(root, "[data-back]");
    const lightbox = new PhotoLightbox(
        element<HTMLDialogElement>(root, "[data-photo-lightbox]"),
    );
    let request: AbortController | undefined;
    let observer: IntersectionObserver | undefined;
    let disposers: (() => void)[] = [];
    let sessionReady: boolean | undefined;

    function reset() {
        lightbox.reset();
        request?.abort();
        observer?.disconnect();
        root.removeAttribute("aria-busy");
        statusBack.hidden = true;
        for (const dispose of disposers) dispose();
        disposers = [];
        grid.replaceChildren();
        element(root, "[data-photo-image]").replaceChildren();
        // Remove private metadata from the DOM when leaving a view or signing out.
        for (const field of detail.querySelectorAll("dd")) {
            field.textContent = "";
        }
        element(detail, "[data-visibility]").hidden = true;
        list.hidden = true;
        detail.hidden = true;
    }

    function showStatus(
        title: string,
        description: string,
        canRetry = false,
        error = false,
    ) {
        status.hidden = false;
        status.setAttribute("role", error ? "alert" : "status");
        statusTitle.textContent = title;
        statusDescription.textContent = description;
        retry.hidden = !canRetry;
    }

    function setText(selector: string, value: string) {
        element(root, selector).textContent = value;
    }

    async function loadImage(
        frame: HTMLElement,
        photo: Photo,
        asset: PhotoAsset | undefined,
        signal: AbortSignal,
        thumbnail: boolean,
    ) {
        frame.classList.add("image-frame");
        const message = document.createElement("p");
        message.className = "image-status";
        message.textContent = asset ? "Loading image…" : "No image available";
        frame.replaceChildren(message);
        if (!asset || signal.aborted) return;
        const showError = () => {
            if (signal.aborted) return;
            frame.replaceChildren(message);
            message.textContent = "Preview unavailable";
            if (!thumbnail) {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "image-retry";
                button.textContent = "Image unavailable. Retry image";
                button.addEventListener("click", () => {
                    void loadImage(frame, photo, asset, signal, false);
                });
                frame.append(button);
            }
        };
        try {
            const source = await cms.readImage(asset.url, signal);
            if (signal.aborted) return;
            const img = document.createElement("img");
            img.alt = thumbnail ? "" : photo.alt;
            img.width = asset.width;
            img.height = asset.height;
            img.decoding = "async";
            img.referrerPolicy = "no-referrer";
            img.hidden = true;
            let url: string;
            if (source.kind === "blob") {
                url = URL.createObjectURL(source.blob);
                disposers.push(() => URL.revokeObjectURL(url));
            } else {
                url = source.url;
            }
            disposers.push(() => img.removeAttribute("src"));
            img.onload = () => {
                if (signal.aborted) return;
                message.remove();
                img.hidden = false;
            };
            img.onerror = showError;
            if (thumbnail) frame.append(img);
            else {
                const button = document.createElement("button");
                button.type = "button";
                button.className = "photo-open";
                button.setAttribute("aria-label", "Enlarge photo");
                button.setAttribute("aria-haspopup", "dialog");
                button.append(img);
                button.addEventListener("click", () => {
                    if (!img.hidden && !signal.aborted)
                        void lightbox.open(img, photo, button);
                });
                frame.append(button);
            }
            img.src = url;
        } catch {
            showError();
        }
    }

    function renderCards(photos: Photo[], offset: number, signal: AbortSignal) {
        const images = new Map<
            HTMLElement,
            { photo: Photo; asset: PhotoAsset | undefined }
        >();
        observer = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (!entry.isIntersecting) continue;
                    const frame = entry.target as HTMLElement;
                    const image = images.get(frame);
                    observer?.unobserve(frame);
                    images.delete(frame);
                    if (image && !signal.aborted) {
                        void loadImage(
                            frame,
                            image.photo,
                            image.asset,
                            signal,
                            true,
                        );
                    }
                }
            },
            { rootMargin: "300px" },
        );

        for (const photo of photos) {
            const card = template.content.cloneNode(true) as DocumentFragment;
            const link = element<HTMLAnchorElement>(card, "a");
            link.href = libraryUrl(offset, photo.id);
            const time = element<HTMLTimeElement>(card, "time");
            time.dateTime = photo.taken;
            time.textContent = dateFormat.format(new Date(photo.taken));
            renderVisibility(element(card, "[data-visibility]"), photo.enabled);
            const frame = element(card, "[data-thumbnail]");
            images.set(frame, {
                photo,
                asset: selectAsset(
                    photo.assets,
                    Math.min(window.devicePixelRatio || 1, 2) * 400,
                ),
            });
            grid.append(card);
            observer.observe(frame);
        }
    }

    async function renderRoute(focus = false) {
        reset();
        const controller = new AbortController();
        request = controller;
        const { signal } = controller;
        const session = await getSession();
        if (signal.aborted) return;
        if (!session.ready) {
            showStatus(
                "Your photographs, in one place.",
                "Sign in above to browse your library and view photo details.",
            );
            document.title = "Photos CMS";
            return;
        }
        const route = readRoute(new URL(window.location.href));
        if (route.invalidPhoto) {
            showStatus(
                "Invalid photo link",
                "Return to your library to choose a photo.",
                false,
                true,
            );
            statusBack.href = libraryUrl(route.offset);
            statusBack.hidden = false;
            if (focus) statusTitle.focus();
            return;
        }
        showStatus(
            route.photo ? "Opening photo…" : "Loading your photos…",
            "Fetching from your library.",
        );
        if (focus) statusTitle.focus();
        root.setAttribute("aria-busy", "true");
        try {
            if (route.photo) {
                back.href = libraryUrl(route.offset);
                const photo = await cms.readPhoto(route.photo, signal);
                if (signal.aborted) return;
                setText(
                    "[data-photo-alt]",
                    photo.alt || "No alt text provided",
                );
                setText(
                    "[data-photo-taken]",
                    timestampFormat.format(new Date(photo.taken)),
                );
                setText(
                    "[data-photo-posted]",
                    timestampFormat.format(new Date(photo.posted)),
                );
                setText(
                    "[data-photo-camera]",
                    photo.camera?.name ?? "Not specified",
                );
                setText(
                    "[data-photo-lens]",
                    photo.lens?.name ?? "Not specified",
                );
                renderVisibility(
                    element(detail, "[data-visibility]"),
                    photo.enabled,
                );
                const largest = selectAsset(photo.assets, Infinity);
                setText(
                    "[data-photo-size]",
                    largest
                        ? `${largest.width} × ${largest.height} px`
                        : "No image assets",
                );
                detail.hidden = false;
                status.hidden = true;
                document.title = "Photos CMS";
                const frame = element(root, "[data-photo-image]");
                const width =
                    (frame.clientWidth || 320) *
                    Math.min(window.devicePixelRatio || 1, 2);
                void loadImage(
                    frame,
                    photo,
                    selectAsset(photo.assets, width),
                    signal,
                    false,
                );
                if (focus) detail.focus();
            } else {
                // One lookahead item tells us whether a Next page exists.
                const page = await cms.listPhotos(
                    route.offset,
                    pageSize + 1,
                    signal,
                );
                if (signal.aborted) return;
                const photos = page.items.slice(0, pageSize);
                if (!photos.length) {
                    showStatus(
                        route.offset
                            ? "No more photos"
                            : "Your library is empty",
                        route.offset
                            ? "Return to an earlier page to see your photos."
                            : "Photos will appear here once they have been uploaded.",
                    );
                } else {
                    renderCards(photos, route.offset, signal);
                    setText(
                        "[data-page-description]",
                        `Photos ${route.offset + 1}–${route.offset + photos.length}`,
                    );
                    status.hidden = true;
                }
                previous.hidden = route.offset === 0;
                previous.href = libraryUrl(
                    Math.max(0, route.offset - pageSize),
                );
                next.hidden = page.items.length <= pageSize;
                next.href = libraryUrl(route.offset + pageSize);
                list.hidden = !photos.length && !route.offset;
                document.title = "Your photos · Photos CMS";
                if (focus && photos.length) element(list, "h2").focus();
            }
        } catch (error) {
            if (signal.aborted) return;
            showStatus(
                error instanceof ApiError && error.status === 404
                    ? "Photo not found"
                    : "Could not open your library",
                error instanceof ApiError
                    ? error.message
                    : "We could not reach the CMS or read its response. Please try again.",
                !(error instanceof ApiError && error.status === 401),
                true,
            );
            if (route.photo) {
                statusBack.href = libraryUrl(route.offset);
                statusBack.hidden = false;
            }
            if (focus) statusTitle.focus();
        } finally {
            if (!signal.aborted) root.removeAttribute("aria-busy");
        }
    }

    root.addEventListener("click", (event) => {
        if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
        )
            return;
        const link = (event.target as Element).closest<HTMLAnchorElement>(
            "a[href]",
        );
        if (!link || !root.contains(link)) return;
        const url = new URL(link.href);
        if (url.origin !== window.location.origin || url.pathname !== "/")
            return;
        event.preventDefault();
        // Push history without a document navigation, preserving in-memory tokens.
        window.history.pushState(null, "", url);
        window.scrollTo(0, 0);
        void renderRoute(true);
    });
    window.addEventListener("popstate", () => void renderRoute(true));
    retry.addEventListener("click", () => void renderRoute(true));
    const refreshSession = async () => {
        await initializeSession();
        const session = await getSession();
        if (session.ready === sessionReady) return;
        sessionReady = session.ready;
        void renderRoute();
    };
    subscribeSession(() => void refreshSession());
    window.addEventListener("pagehide", () => {
        reset();
    });
    window.addEventListener("pageshow", (event) => {
        if (event.persisted) void renderRoute();
    });
    void refreshSession();
}
