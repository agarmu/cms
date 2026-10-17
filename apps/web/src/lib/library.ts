import { cms } from "./api";
import { getSession, initializeSession, subscribeSession } from "./auth";
import {
    ApiError,
    selectAsset,
    type Photo,
    type PhotoAsset,
} from "./cms-client";
import {
    createPhotoUrl,
    libraryUrl,
    pageSize,
    readRoute,
} from "./library-route";
import { PhotoLightbox } from "./photo-lightbox";
import { mountPhotoEditor } from "./photo-editor";
import { renderDescription } from "./photo-description";
import { mountPhotoCreator } from "./photo-creator";

function element<T extends HTMLElement>(root: ParentNode, selector: string): T {
    const found = root.querySelector<T>(selector);
    if (!found) throw new Error(`Missing library element: ${selector}`);
    return found;
}

const timestampFormatter = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    timeZoneName: "short",
});

function formatTimestamp(value: string) {
    const parts = new Map(
        timestampFormatter
            .formatToParts(new Date(value))
            .map((part) => [part.type, part.value]),
    );
    return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")} ${parts.get("hour")}:${parts.get("minute")} ${parts.get("timeZoneName")}`;
}

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
    const createView = element(root, "[data-photo-create-view]");
    const addPhoto = element<HTMLAnchorElement>(document, "[data-add-photo]");
    const grid = element(root, "[data-photo-grid]");
    const template = element<HTMLTemplateElement>(root, "[data-photo-card]");
    const previous = element<HTMLAnchorElement>(root, "[data-previous]");
    const next = element<HTMLAnchorElement>(root, "[data-next]");
    const heading = element(document, "[data-library-heading]");
    const back = element<HTMLAnchorElement>(document, "[data-back]");
    const lightbox = new PhotoLightbox(
        element<HTMLDialogElement>(root, "[data-photo-lightbox]"),
    );
    let request: AbortController | undefined;
    let creationRequest: AbortController | undefined;
    let displayedRoute: ReturnType<typeof readRoute> | undefined;
    let observer: IntersectionObserver | undefined;
    let disposers: (() => void)[] = [];
    let sessionReady: boolean | undefined;
    const editor = mountPhotoEditor(detail, {
        update: renderPhotoMetadata,
        replace: () => void renderRoute(true),
    });
    const creator = mountPhotoCreator(createView, {
        created(id) {
            window.history.replaceState(null, "", libraryUrl(0, id));
            window.scrollTo(0, 0);
            void renderRoute(true);
        },
        cancel() {
            const { offset, photo } = readRoute(new URL(window.location.href));
            const href = libraryUrl(offset, photo ?? undefined);
            window.history.replaceState(null, "", href);
            void transitionRoute(false).then(() => {
                if (
                    window.location.pathname + window.location.search ===
                        href &&
                    !addPhoto.hidden
                )
                    addPhoto.focus({ preventScroll: true });
            });
        },
    });

    function resetCreator() {
        creationRequest?.abort();
        creationRequest = undefined;
        creator.reset();
        createView.hidden = true;
    }

    function syncCreator(route: ReturnType<typeof readRoute>) {
        addPhoto.href = createPhotoUrl(route.offset, route.photo ?? undefined);
        addPhoto.hidden = route.creating;
        if (route.creating) {
            if (!creationRequest) {
                creationRequest = new AbortController();
                createView.hidden = false;
                creator.load(creationRequest.signal);
            }
            document.title = "Add photo · Photos CMS";
        } else if (creationRequest) {
            resetCreator();
            document.title = route.photo
                ? "Photos CMS"
                : "Your photos · Photos CMS";
            addPhoto.focus({ preventScroll: true });
        }
    }

    async function transitionRoute(focus = true) {
        const route = readRoute(new URL(window.location.href));
        if (
            sessionReady &&
            request &&
            !request.signal.aborted &&
            displayedRoute?.offset === route.offset &&
            displayedRoute.photo === route.photo
        ) {
            // Opening or closing a modal keeps the current view and its scroll.
            syncCreator(route);
            return;
        }
        await renderRoute(focus);
    }

    function reset() {
        lightbox.reset();
        request?.abort();
        editor.reset();
        resetCreator();
        displayedRoute = undefined;
        observer?.disconnect();
        root.removeAttribute("aria-busy");
        statusBack.hidden = true;
        for (const dispose of disposers) dispose();
        disposers = [];
        grid.replaceChildren();
        element(root, "[data-photo-image]").replaceChildren();
        element(root, "[data-photo-variants]").replaceChildren();
        // Remove private metadata from the DOM when leaving a view or signing out.
        for (const field of detail.querySelectorAll("[data-photo-field]")) {
            field.textContent = "";
            field.removeAttribute("datetime");
        }
        for (const equipment of detail.querySelectorAll("[data-equipment]"))
            equipment.removeAttribute("title");
        element(detail, "[data-visibility]").hidden = true;
        list.hidden = true;
        detail.hidden = true;
        createView.hidden = true;
        addPhoto.hidden = true;
        heading.hidden = false;
        back.hidden = true;
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

    function renderPhotoMetadata(photo: Photo) {
        for (const [field, fallback] of [
            ["caption", "No caption provided"],
            ["description", "No description provided"],
            ["location", "None"],
            ["altText", "No alt text provided"],
        ] as const) {
            const target = element(detail, `[data-photo-value="${field}"]`);
            if (field === "description" && photo.description)
                target.innerHTML = renderDescription(photo.description);
            else target.textContent = photo[field] || fallback;
            target.classList.toggle("is-empty", !photo[field]);
        }
        for (const image of root.querySelectorAll<HTMLImageElement>(
            "[data-photo-image] img, [data-lightbox-image] img",
        ))
            image.alt = photo.altText;
        for (const [field, selector] of [
            ["takenAt", "taken"],
            ["postedAt", "posted"],
        ] as const) {
            const time = element<HTMLTimeElement>(
                detail,
                `[data-photo-date="${selector}"]`,
            );
            time.textContent = formatTimestamp(photo[field]);
            time.dateTime = photo[field];
        }
        renderEquipment("camera", photo.camera);
        renderEquipment("lens", photo.lens);
        renderVisibility(element(detail, "[data-visibility]"), photo.visible);
        const visibilityButton = element(detail, '[data-edit-field="visible"]');
        visibilityButton.setAttribute(
            "aria-label",
            photo.visible ? "Hide photo" : "Show photo",
        );
    }

    function renderEquipment(
        kind: "camera" | "lens",
        equipment: Photo["camera"] | Photo["lens"],
    ) {
        const name = equipment?.name.trim();
        const label = kind === "camera" ? "Camera" : "Lens";
        const field = element(detail, `[data-photo-equipment="${kind}"]`);
        field.textContent = name || `${label} not specified`;
        field.classList.toggle("sr-only", !name);
        element(detail, `[data-equipment-present="${kind}"]`).hidden = !name;
        element(detail, `[data-equipment-missing="${kind}"]`).hidden =
            Boolean(name);
        const button = element(detail, `[data-equipment="${kind}"]`);
        button.setAttribute(
            "aria-label",
            `Edit ${kind}: ${name || "not specified"}`,
        );
        button.title = name ? `${label}: ${name}` : `${label} not specified`;
    }

    async function loadImage(
        frame: HTMLElement,
        photo: Photo,
        asset: PhotoAsset | undefined,
        signal: AbortSignal,
        thumbnail: boolean,
    ) {
        frame.classList.add("image-frame");
        const visibility = thumbnail
            ? frame.querySelector<HTMLElement>("[data-visibility]")
            : null;
        const message = document.createElement("p");
        message.className = "image-status";
        message.textContent = asset ? "Loading image..." : "No image available";
        frame.replaceChildren(message);
        if (visibility) {
            visibility.hidden = true;
            frame.append(visibility);
        }
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
            img.alt = thumbnail ? "" : photo.altText;
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
            const positionVisibility = () => {
                if (!visibility || signal.aborted || img.hidden) return;
                const imageBounds = img.getBoundingClientRect();
                const frameBounds = frame.getBoundingClientRect();
                visibility.style.top = `${imageBounds.top - frameBounds.top + 6}px`;
                visibility.style.right = `${frameBounds.right - imageBounds.right + 6}px`;
                visibility.hidden = false;
            };
            const imageSizeObserver = visibility
                ? new ResizeObserver(positionVisibility)
                : null;
            if (imageSizeObserver) {
                disposers.push(() => imageSizeObserver.disconnect());
            }
            img.onload = () => {
                if (signal.aborted) return;
                message.remove();
                img.hidden = false;
                positionVisibility();
                imageSizeObserver?.observe(img);
                imageSizeObserver?.observe(frame);
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
            time.dateTime = photo.takenAt;
            time.textContent = formatTimestamp(photo.takenAt).slice(0, 10);
            const visibility = element(card, "[data-visibility]");
            renderVisibility(visibility, photo.visible);
            visibility.hidden = true;
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
        displayedRoute = route;
        heading.hidden = !!route.photo;
        back.hidden = !route.photo;
        back.href = libraryUrl(route.offset);
        syncCreator(route);
        if (route.invalidPhoto) {
            showStatus(
                "Invalid photo link",
                "Return to your library to choose a photo.",
                false,
                true,
            );
            statusBack.href = libraryUrl(route.offset);
            statusBack.hidden = false;
            if (focus && !creationRequest) statusTitle.focus();
            return;
        }
        showStatus(
            route.photo ? "Opening photo..." : "Loading your photos...",
            "Fetching from your library.",
        );
        if (focus && !creationRequest) statusTitle.focus();
        root.setAttribute("aria-busy", "true");
        try {
            if (route.photo) {
                const photo = await cms.readPhoto(route.photo, signal);
                if (signal.aborted) return;
                renderPhotoMetadata(photo);
                editor.load(photo, signal);
                const variants = element(root, "[data-photo-variants]");
                const assets = photo.assets.toSorted(
                    (left, right) =>
                        left.width * left.height - right.width * right.height,
                );
                for (const asset of assets) {
                    const item = document.createElement("li");
                    const name = document.createElement("span");
                    name.className = "variant-name";
                    // Stored filenames contain an upload generation UUID before the configured name.
                    name.textContent = asset.filename
                        .replace(
                            /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-/i,
                            "",
                        )
                        .replace(/\.[^.]+$/, "");
                    const dimensions = document.createElement("span");
                    dimensions.className = "variant-dimensions";
                    dimensions.textContent = `${asset.width} x ${asset.height} px`;
                    item.append(name, " ", dimensions);
                    variants.append(item);
                }
                if (!assets.length) {
                    const item = document.createElement("li");
                    item.textContent = "No image variants";
                    variants.append(item);
                }
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
                if (focus && !creationRequest) detail.focus();
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
                if (focus && photos.length && !creationRequest) grid.focus();
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
            if (focus && !creationRequest) statusTitle.focus();
        } finally {
            if (!signal.aborted) {
                root.removeAttribute("aria-busy");
                if (creationRequest) document.title = "Add photo · Photos CMS";
            }
        }
    }

    function navigate(event: MouseEvent) {
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
        if (
            !link ||
            (!root.contains(link) && link !== back && link !== addPhoto)
        )
            return;
        const url = new URL(link.href);
        if (url.origin !== window.location.origin || url.pathname !== "/")
            return;
        event.preventDefault();
        // Push history without a document navigation, preserving in-memory tokens.
        window.history.pushState(null, "", url);
        const route = readRoute(url);
        if (
            displayedRoute?.offset !== route.offset ||
            displayedRoute.photo !== route.photo
        )
            window.scrollTo(0, 0);
        void transitionRoute();
    }
    root.addEventListener("click", navigate);
    back.addEventListener("click", navigate);
    addPhoto.addEventListener("click", navigate);
    window.addEventListener("popstate", () => void transitionRoute());
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
