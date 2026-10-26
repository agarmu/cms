import { cms } from "./api";
import { ApiError, type Photo, type PhotoChanges } from "./cms-client";
import { localTimestamp, timestampCandidates } from "./photo-dates";

const labels = {
    caption: "Caption",
    description: "Description",
    location: "Location",
    altText: "Alt text",
    takenAt: "Taken",
    postedAt: "Posted",
    visible: "Visibility",
    camera: "Camera",
    lens: "Lens",
    image: "Image",
};
type Field = keyof typeof labels;
const isField = (value: string | undefined): value is Field =>
    value !== undefined && Object.hasOwn(labels, value);

export function mountPhotoEditor(
    root: HTMLElement,
    callbacks: { update(photo: Photo): void; replace(): Promise<void> },
) {
    function element<T extends HTMLElement>(selector: string) {
        const result = root.querySelector<T>(selector);
        if (!result)
            throw new Error(`Missing photo editor element: ${selector}`);
        return result;
    }
    const form = element<HTMLFormElement>("[data-photo-editor]");
    const dialog = element<HTMLDialogElement>("[data-photo-editor-dialog]");
    const title = element("[data-editor-title]");
    const confirmation = element("[data-editor-confirm]");
    const controlGroup = element("[data-editor-control]");
    const fields = element<HTMLFieldSetElement>("[data-editor-fields]");
    const label = element<HTMLLabelElement>("[data-editor-label]");
    const text = element<HTMLTextAreaElement>("[data-editor-text]");
    const location = element<HTMLInputElement>("[data-editor-location]");
    const date = element<HTMLInputElement>("[data-editor-date]");
    const select = element<HTMLSelectElement>("[data-editor-select]");
    const file = element<HTMLInputElement>("[data-editor-file]");
    const filePicker = element("[data-editor-file-picker]");
    const fileName = element("[data-editor-file-name]");
    const newName = element<HTMLInputElement>("[data-editor-name]");
    const newNameLabel = element<HTMLLabelElement>(
        'label[for="photo-editor-name"]',
    );
    const newNameGroup = element("[data-editor-new-name]");
    const timeChoice = element("[data-editor-time-choice]");
    const offset = element<HTMLSelectElement>("[data-editor-offset]");
    const help = element("[data-editor-help]");
    const reminder = element("[data-editor-reminder]");
    const error = element("[data-editor-error]");
    const status = element("[data-editor-status]");
    const save = element<HTMLButtonElement>("[data-editor-save]");
    const cancel = element<HTMLButtonElement>("[data-editor-cancel]");
    const buttons = [
        ...root.querySelectorAll<HTMLButtonElement>("[data-edit-field]"),
    ];
    let photo: Photo | undefined;
    let routeSignal: AbortSignal | undefined;
    let request: AbortController | undefined;
    let editing: Field | undefined;
    let opener: HTMLButtonElement | undefined;
    let busy = false;
    let loading = false;
    let candidates: string[] = [];
    let confirmedImage: File | undefined;
    let statusTimeout: number | undefined;

    function hideSaved() {
        window.clearTimeout(statusTimeout);
        statusTimeout = undefined;
        status.textContent = "";
        status.hidden = true;
    }

    function showSaved(field: Field) {
        hideSaved();
        status.hidden = false;
        status.textContent =
            field === "image" ? "Image replaced." : `${labels[field]} saved.`;
        statusTimeout = window.setTimeout(hideSaved, 3000);
    }

    function restoreButtons() {
        for (const button of buttons) {
            button.disabled = false;
            button.hidden = false;
        }
    }
    function close(restoreFocus = true) {
        request?.abort();
        editing = undefined;
        busy = false;
        loading = false;
        form.hidden = true;
        form.removeAttribute("aria-busy");
        form.removeAttribute("data-finish-required");
        form.removeAttribute("aria-describedby");
        reminder.textContent = "";
        reminder.hidden = true;
        form.reset();
        fileName.textContent = "No file selected";
        date.setCustomValidity("");
        select.replaceChildren();
        offset.replaceChildren();
        candidates = [];
        confirmedImage = undefined;
        confirmation.textContent = "";
        confirmation.hidden = true;
        fields.disabled = false;
        select.disabled = false;
        save.textContent = "Save";
        save.disabled = true;
        for (const value of root.querySelectorAll<HTMLElement>(
            "[data-photo-value]",
        ))
            value.hidden = false;
        error.textContent = "";
        error.hidden = true;
        hideSaved();
        restoreButtons();
        if (dialog.open) dialog.close();
        if (restoreFocus) opener?.focus();
        opener = undefined;
    }
    function updateDates() {
        candidates = timestampCandidates(date.value);
        const message = candidates.length
            ? ""
            : "Enter a valid local date and time. Times skipped by a clock change cannot be used.";
        date.setCustomValidity(message);
        error.textContent = message;
        error.hidden = !message;
        offset.replaceChildren(new Option("Choose an occurrence", ""));
        for (const candidate of candidates) {
            const title = new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "long",
            }).format(new Date(candidate));
            offset.add(new Option(title, candidate));
        }
        const original =
            photo && (editing === "takenAt" || editing === "postedAt")
                ? new Date(photo[editing]).toISOString()
                : "";
        offset.value = candidates.includes(original)
            ? original
            : candidates.length === 1
              ? candidates[0]!
              : "";
        timeChoice.hidden = candidates.length < 2;
    }
    function draft():
        { changes?: PhotoChanges; name?: string; image?: File } | undefined {
        if (!photo || !editing) return;
        if (
            editing === "caption" ||
            editing === "description" ||
            editing === "altText"
        )
            return text.value === photo[editing]
                ? undefined
                : { changes: { [editing]: text.value } };
        if (editing === "location") {
            const value = location.value.trim() || null;
            return value === photo.location
                ? undefined
                : { changes: { location: value } };
        }
        if (editing === "takenAt" || editing === "postedAt") {
            const value =
                candidates.length === 1 ? candidates[0] : offset.value;
            return !value || value === new Date(photo[editing]).toISOString()
                ? undefined
                : { changes: { [editing]: value } };
        }
        if (editing === "visible") {
            return { changes: { visible: !photo.visible } };
        }
        if (editing === "camera" || editing === "lens") {
            if (select.value === "__rename__") {
                const name = newName.value.trim();
                return name && name !== photo[editing]?.name
                    ? { name }
                    : undefined;
            }
            if (select.value === "__new__")
                return newName.value.trim()
                    ? {
                          changes: {
                              [editing]: {
                                  create: { name: newName.value.trim() },
                              },
                          },
                      }
                    : undefined;
            return select.value === (photo[editing]?.id ?? "")
                ? undefined
                : {
                      changes: {
                          [editing]: select.value ? { id: select.value } : null,
                      },
                  };
        }
        const image = file.files?.[0];
        return image?.size ? { image } : undefined;
    }
    function update() {
        if (editing === "image")
            fileName.textContent = file.files?.[0]?.name ?? "No file selected";
        newNameGroup.hidden =
            !(editing === "camera" || editing === "lens") ||
            (select.value !== "__new__" && select.value !== "__rename__");
        if (editing === "camera" || editing === "lens") {
            const renaming = select.value === "__rename__";
            newNameLabel.textContent = renaming
                ? `Shared ${editing} name`
                : `New ${editing} name`;
            help.hidden = !renaming;
            help.textContent = renaming
                ? "Renaming this equipment changes its name on every linked photo."
                : "";
        }
        save.disabled = busy || loading || !draft();
    }
    async function open(button: HTMLButtonElement) {
        const field = button.dataset["editField"];
        if (!photo || routeSignal?.aborted || editing || !isField(field))
            return;
        editing = field;
        opener = button;
        request = new AbortController();
        const signal = request.signal;
        for (const control of [text, location, date, select, file])
            control.hidden = true;
        newNameGroup.hidden = true;
        timeChoice.hidden = true;
        help.hidden = true;
        confirmation.hidden = true;
        controlGroup.hidden = field === "visible";
        filePicker.hidden = field !== "image";
        label.hidden = false;
        hideSaved();
        label.textContent = labels[field];
        form.setAttribute("aria-label", `Edit ${labels[field].toLowerCase()}`);
        title.textContent =
            field === "image"
                ? "Replace image"
                : field === "takenAt" || field === "postedAt"
                  ? `Edit ${labels[field].toLowerCase()} date`
                  : `Edit ${labels[field].toLowerCase()}`;
        dialog.toggleAttribute(
            "data-date-editor",
            field === "takenAt" || field === "postedAt",
        );
        const inline =
            field === "caption" ||
            field === "description" ||
            field === "altText" ||
            field === "location";
        label.classList.add("sr-only");
        element(`[data-editor-slot="${inline ? field : "modal"}"]`).append(
            form,
        );
        if (inline) element(`[data-photo-value="${field}"]`).hidden = true;
        for (const other of buttons) other.disabled = true;
        button.hidden = inline;
        form.hidden = false;
        let control:
            | HTMLTextAreaElement
            | HTMLInputElement
            | HTMLSelectElement
            | undefined = text;
        text.classList.toggle("markdown-input", field === "description");
        if (
            field === "caption" ||
            field === "description" ||
            field === "altText"
        ) {
            text.value = photo[field];
            text.rows = field === "caption" ? 4 : 6;
            if (field === "description") {
                help.textContent = "Supports Markdown.";
                help.hidden = false;
            }
        } else if (field === "location") {
            control = location;
            location.value = photo.location ?? "";
        } else if (field === "takenAt" || field === "postedAt") {
            control = date;
            date.value = localTimestamp(photo[field]);
            updateDates();
            help.textContent = `Timezone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
            help.hidden = false;
        } else if (field === "image") {
            control = file;
            help.textContent =
                "The new image will replace this photo's image and regenerate its variants.";
            help.hidden = false;
            save.textContent = "Confirm file";
        } else if (field === "visible") {
            control = undefined;
            label.hidden = true;
            title.textContent = photo.visible ? "Hide photo?" : "Show photo?";
            confirmation.textContent = photo.visible
                ? "This photo will be hidden."
                : "This photo will be visible.";
            confirmation.hidden = false;
            save.textContent = "Confirm";
        } else {
            control = select;
            select.replaceChildren();
            const current = photo[field];
            select.add(new Option("Not specified", ""));
            if (current) select.add(new Option(current.name, current.id));
            select.add(new Option(`Create a new ${field}…`, "__new__"));
            if (current)
                select.add(new Option(`Rename shared ${field}…`, "__rename__"));
            select.value = current?.id ?? "";
            loading = true;
            select.disabled = true;
            void cms
                .listEquipment(field, signal)
                .then((items) => {
                    if (signal.aborted) return;
                    for (const item of items)
                        if (item.id !== current?.id)
                            select.add(new Option(item.name, item.id));
                })
                .catch(() => {
                    if (signal.aborted) return;
                    error.textContent =
                        "Could not load equipment choices. Cancel and try again.";
                    error.hidden = false;
                })
                .finally(() => {
                    if (!signal.aborted) {
                        loading = false;
                        select.disabled = false;
                        update();
                    }
                });
        }
        if (control) {
            control.hidden = false;
            control.name = field;
            label.htmlFor = control.id;
        }
        update();
        if (!inline) dialog.showModal();
        if (control) control.focus();
        else cancel.focus();
    }
    for (const button of buttons)
        button.addEventListener("click", () => void open(button));
    form.addEventListener("input", (event) => {
        if (event.target === date) updateDates();
        update();
    });
    form.addEventListener("change", update);
    file.addEventListener("change", () => {
        if (editing !== "image" || busy) return;
        confirmedImage = undefined;
        controlGroup.hidden = false;
        confirmation.textContent = "";
        confirmation.hidden = true;
        title.textContent = "Replace image";
        help.hidden = false;
        save.textContent = "Confirm file";
        update();
    });
    select.addEventListener("change", () => {
        if (editing === "camera" || editing === "lens") {
            newName.value =
                select.value === "__rename__"
                    ? (photo?.[editing]?.name ?? "")
                    : "";
            update();
        }
    });
    dialog.addEventListener("cancel", (event) => {
        event.preventDefault();
        if (!busy) close();
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
            close();
    });
    cancel.addEventListener("click", () => {
        if (!busy) close();
    });
    save.addEventListener("click", (event) => {
        if (editing === "image" && event.detail > 1) event.preventDefault();
    });
    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        const current = photo,
            field = editing,
            controller = request;
        if (
            !current ||
            !field ||
            !controller ||
            controller.signal.aborted ||
            busy ||
            loading
        )
            return;
        const value = draft();
        if (!value) return;
        if (value.image && confirmedImage !== value.image) {
            confirmedImage = value.image;
            title.textContent = "Replace image?";
            confirmation.textContent = `Replace the current image with “${value.image.name}”?`;
            confirmation.hidden = false;
            controlGroup.hidden = true;
            help.hidden = true;
            save.textContent = "Replace image";
            cancel.focus();
            return;
        }
        busy = true;
        fields.disabled = true;
        update();
        save.textContent = field === "image" ? "Replacing…" : "Saving…";
        form.setAttribute("aria-busy", "true");
        error.hidden = true;
        try {
            if (value.name) {
                const kind = field === "camera" ? "camera" : "lens";
                const equipment = current[kind];
                if (!equipment) return;
                current[kind] = await cms.renameEquipment(
                    kind,
                    equipment.id,
                    value.name,
                    controller.signal,
                );
            } else {
                const result = value.image
                    ? await cms.replaceImage(
                          current.id,
                          value.image,
                          controller.signal,
                      )
                    : await cms.updatePhoto(
                          current.id,
                          value.changes!,
                          controller.signal,
                      );
                if (controller.signal.aborted || photo !== current) return;
                if (!("altText" in result)) {
                    close();
                    await callbacks.replace();
                    return;
                }
                Object.assign(current, result);
            }
            if (controller.signal.aborted || photo !== current) return;
            callbacks.update(current);
            close();
            if (field === "image") {
                await callbacks.replace();
                if (photo?.id !== current.id || routeSignal?.aborted) return;
            }
            showSaved(field);
        } catch (failure) {
            if (controller.signal.aborted || photo !== current) return;
            error.textContent =
                failure instanceof ApiError && failure.status === 403
                    ? "You do not have permission to make this change."
                    : "Could not save. Your changes are still here. Please try again.";
            error.hidden = false;
        } finally {
            if (!controller.signal.aborted && photo === current) {
                busy = false;
                fields.disabled = false;
                save.textContent =
                    field === "image"
                        ? "Replace image"
                        : field === "visible"
                          ? "Confirm"
                          : "Save";
                form.removeAttribute("aria-busy");
                update();
            }
        }
    });
    return {
        requireFinished(message: string) {
            if (!editing) return true;
            reminder.textContent = message;
            reminder.hidden = false;
            form.setAttribute("data-finish-required", "");
            form.setAttribute("aria-describedby", reminder.id);
            const action = save.matches(":disabled") ? cancel : save;
            if (!action.matches(":disabled")) action.focus();
            else form.scrollIntoView({ block: "nearest" });
            return false;
        },
        load(value: Photo, signal: AbortSignal) {
            photo = value;
            routeSignal = signal;
            restoreButtons();
        },
        reset() {
            close(false);
            photo = undefined;
            routeSignal = undefined;
        },
    };
}
