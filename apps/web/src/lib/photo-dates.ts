const pad = (value: number, length = 2) => String(value).padStart(length, "0");

export function localTimestamp(value: string) {
    const date = new Date(value);
    const base = `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
    const seconds = date.getSeconds();
    const milliseconds = date.getMilliseconds();
    return (
        base +
        (seconds || milliseconds ? `:${pad(seconds)}` : "") +
        (milliseconds ? `.${pad(milliseconds, 3).replace(/0+$/, "")}` : "")
    );
}

// A local clock time can identify zero, one, or two instants at a DST transition.
export function timestampCandidates(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/.test(value))
        return [];
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return [];
    const offsets = new Set<number>();
    for (let hours = -48; hours <= 48; hours += 6)
        offsets.add(
            new Date(date.getTime() + hours * 3_600_000).getTimezoneOffset(),
        );
    return [...offsets]
        .map((offset) =>
            new Date(
                date.getTime() + (offset - date.getTimezoneOffset()) * 60_000,
            ).toISOString(),
        )
        .filter((candidate) => localTimestamp(candidate) === value)
        .sort();
}
