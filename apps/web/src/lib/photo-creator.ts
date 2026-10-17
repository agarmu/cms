import { cms } from "./api";
import { ApiError, type NewPhoto } from "./cms-client";
import { localTimestamp, timestampCandidates } from "./photo-dates";
import { renderDescription } from "./photo-description";

export function mountPhotoCreator(
    root: HTMLElement,
    callbacks: { created(id: string): void; cancel(): void },
) {
    function element<T extends HTMLElement>(selector: string) {
        const found = root.querySelector<T>(selector);
        if (!found)
            throw new Error(`Missing photo creation element: ${selector}`);
        return found;
    }
    const form = element<HTMLFormElement>("[data-photo-create-form]");
    const dialog = root as HTMLDialogElement;
    const title = element("[data-create-title]");
    const progress = element("[data-create-progress]");
    const previous = element<HTMLButtonElement>("[data-create-back]");
    const reviewImage = element<HTMLImageElement>("[data-create-review-image]");
    const steps = [...root.querySelectorAll<HTMLElement>("[data-create-step]")];
    const stepTitles = [
        "Choose image",
        "Photo details",
        "Dates and equipment",
        "Review photo",
    ];
    let step = 0;
    const fields = element<HTMLFieldSetElement>("[data-create-fields]");
    const scroll = element("[data-create-scroll]");
    const file = element<HTMLInputElement>("[data-create-file]");
    const fileName = element("[data-create-file-name]");
    const preview = element<HTMLImageElement>("[data-create-preview]");
    const previewStatus = element("[data-create-preview-status]");
    const caption = element<HTMLInputElement>("[data-create-caption]");
    const description = element<HTMLTextAreaElement>(
        "[data-create-description]",
    );
    const altText = element<HTMLTextAreaElement>("[data-create-alt]");
    const location = element<HTMLInputElement>("[data-create-location]");
    const visible = element<HTMLInputElement>("[data-create-visible]");
    const save = element<HTMLButtonElement>("[data-create-save]");
    const cancel = element<HTMLButtonElement>("[data-create-cancel]");
    const status = element("[data-create-status]");
    const error = element("[data-create-error]");
    const dates = (["takenAt", "postedAt"] as const).map((kind) => ({
        kind,
        input: element<HTMLInputElement>(`[data-create-date="${kind}"]`),
        choice: element<HTMLSelectElement>(`[data-create-offset="${kind}"]`),
        group: element(`[data-create-time-choice="${kind}"]`),
        error: element(`[data-create-date-error="${kind}"]`),
        candidates: [] as string[],
    }));
    const equipment = (["camera", "lens"] as const).map((kind) => ({
        kind,
        select: element<HTMLSelectElement>(`[data-create-equipment="${kind}"]`),
        name: element<HTMLInputElement>(
            `[data-create-equipment-name="${kind}"]`,
        ),
        group: element(`[data-create-new-equipment="${kind}"]`),
        status: element(`[data-create-equipment-status="${kind}"]`),
    }));
    let routeSignal: AbortSignal | undefined;
    let request: AbortController | undefined;
    let previewUrl: string | undefined;
    let uploadId: string | undefined;
    // Retain exactly the same payload after an uncertain response; creation is
    // idempotent for one upload receipt, preventing duplicate photos on retry.
    let submitted: NewPhoto | undefined;
    let busy = false;

    function refreshDate(
        field: (typeof dates)[number],
        preferred = field.choice.value,
    ) {
        field.candidates = timestampCandidates(field.input.value);
        field.input.setCustomValidity(
            field.candidates.length ? "" : "Enter a valid local date and time.",
        );
        field.error.textContent = field.candidates.length
            ? ""
            : "Enter a valid local time. Times skipped by a clock change cannot be used.";
        field.error.hidden = !!field.candidates.length;
        field.choice.replaceChildren(new Option("Choose an occurrence", ""));
        for (const value of field.candidates)
            field.choice.add(
                new Option(
                    new Intl.DateTimeFormat(undefined, {
                        dateStyle: "medium",
                        timeStyle: "long",
                    }).format(new Date(value)),
                    value,
                ),
            );
        field.choice.value = field.candidates.includes(preferred)
            ? preferred
            : field.candidates.length === 1
              ? field.candidates[0]!
              : "";
        field.group.hidden = field.candidates.length < 2;
        field.choice.required = !field.group.hidden;
    }
    function metadata(): NewPhoto | undefined {
        const takenAt = dates[0]!.choice.value;
        const postedAt = dates[1]!.choice.value;
        if (
            !takenAt ||
            !postedAt ||
            !file.files?.[0]?.size ||
            file.validationMessage
        )
            return;
        const links = equipment.map(({ select, name }) => {
            if (select.value === "__new__")
                return name.value.trim()
                    ? { create: { name: name.value.trim() } }
                    : undefined;
            return select.value ? { id: select.value } : null;
        });
        if (links.some((link) => link === undefined)) return;
        return {
            takenAt,
            postedAt,
            caption: caption.value,
            description: description.value,
            altText: altText.value,
            location: location.value.trim() || null,
            visible: visible.checked,
            camera: links[0]!,
            lens: links[1]!,
        };
    }
    function update() {
        for (const field of equipment) {
            field.group.hidden = field.select.value !== "__new__";
            field.name.required = !field.group.hidden;
        }
        fields.disabled = busy || !!submitted;
        const validImage = !!file.files?.[0]?.size && !file.validationMessage;
        save.disabled =
            busy ||
            (step === 0
                ? !validImage
                : step === 1
                  ? false
                  : !(submitted || metadata()));
        cancel.disabled = busy;
        previous.hidden = step === 0;
        previous.disabled = busy || !!submitted;
        if (!busy)
            save.textContent = submitted
                ? "Retry adding"
                : step === 3
                  ? "Add photo"
                  : "Next";
    }
    function renderReview() {
        const value = submitted ?? metadata();
        if (!value) return;
        const formatter = new Intl.DateTimeFormat(undefined, {
            dateStyle: "medium",
            timeStyle: "long",
        });
        const values: Record<string, string> = {
            location: value.location ?? "",
            caption: value.caption,
            description: value.description,
            altText: value.altText,
            takenAt: formatter.format(new Date(value.takenAt)),
            postedAt: formatter.format(new Date(value.postedAt)),
            visible: value.visible ? "Visible" : "Hidden",
        };
        for (const field of equipment)
            values[field.kind] =
                field.select.value === "__new__"
                    ? field.name.value.trim()
                    : field.select.value
                      ? (field.select.selectedOptions[0]?.textContent ?? "")
                      : "";
        for (const [field, text] of Object.entries(values)) {
            const target = element(`[data-create-review="${field}"]`);
            if (field === "description" && text)
                target.innerHTML = renderDescription(text);
            else target.textContent = text || "None";
            target.classList.toggle("is-empty", !text);
            target.parentElement!.hidden =
                !text &&
                [
                    "location",
                    "caption",
                    "description",
                    "altText",
                    "camera",
                    "lens",
                ].includes(field);
        }
        element("[data-create-review-file]").textContent =
            file.files?.[0]?.name ?? "";
        if (previewUrl) {
            reviewImage.hidden = preview.hidden;
            reviewImage.src = previewUrl;
        }
    }
    function showStep(value: number, focus = true) {
        step = value;
        for (const [index, section] of steps.entries())
            section.hidden = index !== step;
        title.textContent = stepTitles[step]!;
        progress.textContent = `${step + 1} of ${steps.length}`;
        scroll.scrollTop = 0;
        error.hidden = true;
        if (step === 3) renderReview();
        update();
        if (focus) title.focus();
    }
    function releasePreview() {
        preview.removeAttribute("src");
        reviewImage.removeAttribute("src");
        reviewImage.hidden = true;
        preview.hidden = true;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = undefined;
    }
    function cancelUpload() {
        const id = uploadId;
        uploadId = undefined;
        if (id) void cms.cancelPhotoUpload(id).catch(() => {});
    }
    function reset() {
        if (dialog.open) dialog.close();
        request?.abort();
        request = undefined;
        routeSignal = undefined;
        cancelUpload();
        submitted = undefined;
        busy = false;
        releasePreview();
        form.reset();
        form.removeAttribute("aria-busy");
        fields.disabled = false;
        file.setCustomValidity("");
        fileName.textContent = "Select a file";
        previewStatus.textContent = "";
        previewStatus.hidden = true;
        for (const field of dates) {
            field.input.setCustomValidity("");
            field.choice.replaceChildren();
            field.choice.required = false;
            field.candidates = [];
            field.group.hidden = true;
            field.error.textContent = "";
            field.error.hidden = true;
        }
        for (const field of equipment) {
            field.select.replaceChildren(
                new Option("None", ""),
                new Option("Create new…", "__new__"),
            );
            field.name.value = "";
            field.name.required = false;
            field.group.hidden = true;
            field.status.textContent = "";
            field.status.hidden = true;
        }
        for (const value of root.querySelectorAll<HTMLElement>(
            "[data-create-review], [data-create-review-file]",
        ))
            value.textContent = "";
        status.textContent = "";
        status.hidden = true;
        error.textContent = "";
        error.hidden = true;
        save.textContent = "Add photo";
        save.disabled = true;
        cancel.disabled = false;
        showStep(0, false);
    }
    file.addEventListener("change", () => {
        if (busy || submitted) return;
        cancelUpload();
        releasePreview();
        const selected = file.files?.[0];
        fileName.textContent = selected?.name ?? "Select a file";
        file.setCustomValidity("");
        error.hidden = true;
        previewStatus.hidden = true;
        previewStatus.textContent = "";
        if (selected) {
            if (
                !selected.size ||
                ![
                    "image/jpeg",
                    "image/png",
                    "image/webp",
                    "image/avif",
                    "image/tiff",
                ].includes(selected.type)
            ) {
                file.setCustomValidity(
                    "Choose a non-empty JPEG, PNG, WebP, AVIF, or TIFF image.",
                );
                error.textContent = file.validationMessage;
                error.hidden = false;
            } else {
                previewUrl = URL.createObjectURL(selected);
                preview.src = previewUrl;
                previewStatus.textContent = "Loading preview…";
                previewStatus.hidden = false;
            }
        }
        update();
    });
    preview.addEventListener("load", () => {
        if (!previewUrl || preview.src !== previewUrl) return;
        preview.hidden = false;
        previewStatus.hidden = true;
    });
    preview.addEventListener("error", () => {
        if (!previewUrl || preview.src !== previewUrl) return;
        preview.hidden = true;
        previewStatus.textContent =
            "Preview unavailable. You can still upload this image.";
        previewStatus.hidden = false;
    });
    reviewImage.addEventListener("load", () => {
        if (previewUrl && reviewImage.src === previewUrl)
            reviewImage.hidden = false;
    });
    reviewImage.addEventListener("error", () => {
        reviewImage.hidden = true;
    });
    form.addEventListener("input", (event) => {
        const field = dates.find((field) => field.input === event.target);
        if (field) refreshDate(field);
        update();
    });
    form.addEventListener("change", update);
    cancel.addEventListener("click", () => {
        if (!busy) callbacks.cancel();
    });
    previous.addEventListener("click", () => {
        if (!busy && !submitted && step > 0) showStep(step - 1);
    });
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (!busy) callbacks.cancel();
    });
    dialog.addEventListener("click", (event) => {
        if (event.target !== dialog || busy) return;
        const bounds = dialog.getBoundingClientRect();
        if (
            event.clientX < bounds.left ||
            event.clientX > bounds.right ||
            event.clientY < bounds.top ||
            event.clientY > bounds.bottom
        )
            callbacks.cancel();
    });
    save.addEventListener("click", (event) => {
        if (event.detail > 1) event.preventDefault();
    });
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        if (busy || !routeSignal || routeSignal.aborted) return;
        if (step < 3) {
            if (!save.disabled) showStep(step + 1);
            return;
        }
        const selected = file.files?.[0];
        const value = submitted ?? metadata();
        if (!selected || !value || busy || !routeSignal || routeSignal.aborted)
            return;
        const controller = new AbortController();
        request = controller;
        const signal = controller.signal;
        busy = true;
        form.setAttribute("aria-busy", "true");
        error.hidden = true;
        status.hidden = false;
        save.textContent = "Adding…";
        update();
        try {
            if (!uploadId) {
                const id = await cms.preparePhotoUpload(
                    selected,
                    signal,
                    (phase) => {
                        if (!signal.aborted)
                            status.textContent =
                                phase === "uploading"
                                    ? "Uploading image…"
                                    : "Processing image…";
                    },
                );
                if (signal.aborted) {
                    void cms.cancelPhotoUpload(id).catch(() => {});
                    return;
                }
                uploadId = id;
            }
            submitted = value;
            status.textContent = "Adding photo…";
            const created = await cms.createPhoto(uploadId, value, signal);
            if (signal.aborted) return;
            uploadId = undefined;
            submitted = undefined;
            callbacks.created(created.id);
        } catch (failure) {
            if (signal.aborted) return;
            const uncertain =
                !!submitted &&
                !(
                    failure instanceof ApiError &&
                    failure.status >= 400 &&
                    failure.status < 500 &&
                    failure.status !== 408
                );
            if (!uncertain) submitted = undefined;
            const unusableUpload =
                failure instanceof ApiError &&
                [404, 409, 410].includes(failure.status);
            if (unusableUpload) cancelUpload();
            error.textContent =
                failure instanceof ApiError && failure.status === 403
                    ? "You do not have permission to add photos."
                    : uncertain
                      ? "Could not confirm that your photo was added. Retry to check the same upload."
                      : unusableUpload
                        ? "This upload is no longer available. Try again to upload a fresh copy."
                        : "Could not add the photo. Your image and details are still here. Please try again.";
            error.hidden = false;
            status.hidden = true;
        } finally {
            if (!signal.aborted) {
                busy = false;
                form.removeAttribute("aria-busy");
                save.textContent = submitted
                    ? "Retry adding photo"
                    : "Add photo";
                update();
            }
        }
    });
    return {
        reset,
        load(signal: AbortSignal) {
            routeSignal = signal;
            const now = new Date().toISOString();
            for (const field of dates) {
                field.input.value = localTimestamp(now);
                refreshDate(field, now);
            }
            element("[data-create-timezone]").textContent =
                `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
            for (const field of equipment)
                void cms
                    .listEquipment(field.kind, signal)
                    .then((items) => {
                        if (signal.aborted) return;
                        for (const item of items)
                            field.select.add(new Option(item.name, item.id));
                    })
                    .catch(() => {
                        if (signal.aborted) return;
                        field.status.textContent =
                            "Existing choices unavailable. You can leave this empty or create a new one.";
                        field.status.hidden = false;
                    });
            update();
            showStep(0, false);
            dialog.showModal();
            file.focus();
        },
    };
}
