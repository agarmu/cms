import { cms } from "./api";
import { selectAsset, type Photo } from "./cms-client";

// Match the expand/collapse motion of the website's single-image lightbox.
function sourceTransform(source: HTMLImageElement, image: HTMLImageElement) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = source.getBoundingClientRect();
    const end = image.getBoundingClientRect();
    if (!start.width || !start.height || !end.width || !end.height) return;
    const scale = Math.min(start.width / end.width, start.height / end.height);
    return `translate(${start.x + start.width / 2 - end.x - end.width / 2}px, ${start.y + start.height / 2 - end.y - end.height / 2}px) scale(${scale})`;
}

export class PhotoLightbox {
    private readonly stage: HTMLElement;
    private source: HTMLImageElement | undefined;
    private opener: HTMLElement | undefined;
    private request: AbortController | undefined;
    private animation: Animation | undefined;
    private objectUrls: string[] = [];
    private version = 0;
    private closing = false;
    private previousOverflow: string | undefined;

    constructor(private readonly dialog: HTMLDialogElement) {
        this.stage = dialog.querySelector<HTMLElement>(
            "[data-lightbox-image]",
        )!;
        dialog.addEventListener("click", () => void this.close());
        dialog.addEventListener("cancel", (event) => {
            event.preventDefault();
            void this.close();
        });
    }

    async open(source: HTMLImageElement, photo: Photo, opener: HTMLElement) {
        if (this.dialog.open) return;
        this.reset();
        this.source = source;
        this.opener = opener;
        const version = this.version;
        const controller = new AbortController();
        this.request = controller;
        const previewWidth =
            Number(source.getAttribute("width")) || source.naturalWidth;
        const previewHeight =
            Number(source.getAttribute("height")) || source.naturalHeight;
        const width = Math.min(
            window.innerWidth - 48,
            ((window.innerHeight - 48) * previewWidth) / previewHeight,
        );
        const asset = selectAsset(
            photo.assets,
            width * (window.devicePixelRatio || 1),
        );
        const image = new Image();
        image.alt = source.alt;
        image.width = asset?.width ?? previewWidth;
        image.height = asset?.height ?? previewHeight;
        image.decoding = "async";
        image.referrerPolicy = "no-referrer";
        image.src = source.currentSrc || source.src;
        await image.decode().catch(() => {});
        if (controller.signal.aborted || version !== this.version) return;
        this.stage.replaceChildren(image);
        this.previousOverflow = document.documentElement.style.overflow;
        document.documentElement.style.overflow = "hidden";
        this.dialog.showModal();
        const transform = sourceTransform(source, image);
        if (transform) {
            this.animation = image.animate(
                [{ transform }, { transform: "none" }],
                { duration: 320, easing: "cubic-bezier(.4, 0, .2, 1)" },
            );
        }

        // Keep the already loaded preview visible while fetching a larger asset.
        if (!asset || asset.width <= previewWidth) return;
        try {
            const result = await cms.readImage(asset.url, controller.signal);
            if (
                controller.signal.aborted ||
                version !== this.version ||
                this.closing
            )
                return;
            let url: string;
            if (result.kind === "blob") {
                url = URL.createObjectURL(result.blob);
                this.objectUrls.push(url);
            } else url = result.url;
            const fullImage = new Image();
            fullImage.alt = photo.alt;
            fullImage.width = asset.width;
            fullImage.height = asset.height;
            fullImage.decoding = "async";
            fullImage.referrerPolicy = "no-referrer";
            fullImage.src = url;
            await fullImage.decode();
            if (
                controller.signal.aborted ||
                version !== this.version ||
                this.closing
            )
                return;
            await this.animation?.finished.catch(() => {});
            if (
                controller.signal.aborted ||
                version !== this.version ||
                this.closing
            )
                return;
            this.stage.replaceChildren(fullImage);
        } catch {
            // The preview remains usable if the larger image cannot be loaded.
        }
    }

    private async close() {
        if (this.closing || !this.dialog.open) return;
        this.closing = true;
        this.request?.abort();
        const version = this.version;
        const image = this.stage.querySelector("img");
        this.animation?.cancel();
        const transform =
            image && this.source && sourceTransform(this.source, image);
        if (image && transform) {
            this.dialog.setAttribute("data-closing", "");
            this.animation = image.animate(
                [{ transform: "none" }, { transform }],
                {
                    duration: 280,
                    easing: "cubic-bezier(.4, 0, .2, 1)",
                    fill: "forwards",
                },
            );
            await this.animation.finished.catch(() => {});
        }
        if (version === this.version) this.reset(true);
    }

    reset(restoreFocus = false) {
        this.version++;
        this.request?.abort();
        this.animation?.cancel();
        this.animation = undefined;
        this.closing = false;
        this.dialog.removeAttribute("data-closing");
        if (this.dialog.open) this.dialog.close();
        for (const image of this.stage.querySelectorAll("img"))
            image.removeAttribute("src");
        this.stage.replaceChildren();
        for (const url of this.objectUrls) URL.revokeObjectURL(url);
        this.objectUrls = [];
        if (this.previousOverflow !== undefined) {
            document.documentElement.style.overflow = this.previousOverflow;
            this.previousOverflow = undefined;
        }
        if (restoreFocus && this.opener?.isConnected)
            this.opener.focus({ preventScroll: true });
        this.opener = undefined;
        this.source = undefined;
    }
}
