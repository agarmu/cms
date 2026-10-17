/// <reference types="bun" />
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";

function dates(zone: string, expression: string) {
    const result = spawnSync(
        process.execPath,
        [
            "-e",
            `import {localTimestamp, timestampCandidates} from ${JSON.stringify(new URL("./photo-dates.ts", import.meta.url).pathname)}; console.log(JSON.stringify(${expression}));`,
        ],
        { env: { ...process.env, TZ: zone }, encoding: "utf8" },
    );
    if (result.status !== 0) throw new Error(result.stderr);
    return JSON.parse(result.stdout) as unknown;
}
test("browser-local date conversion preserves seconds and milliseconds", () => {
    expect(
        dates(
            "America/Indiana/Indianapolis",
            'localTimestamp("2026-10-16T01:02:03.120Z")',
        ),
    ).toBe("2026-10-15T21:02:03.12");
    expect(
        dates("Asia/Tokyo", 'timestampCandidates("2026-10-17T08:02:03.12")'),
    ).toEqual(["2026-10-16T23:02:03.120Z"]);
});
test("nonexistent or invalid local clock times have no candidates", () => {
    expect(
        dates("America/New_York", 'timestampCandidates("2026-03-08T02:30")'),
    ).toEqual([]);
    expect(dates("UTC", 'timestampCandidates("2026-02-30T12:00")')).toEqual([]);
});
test("a repeated clock time exposes both instants for an explicit choice", () => {
    expect(
        dates("America/New_York", 'timestampCandidates("2026-11-01T01:30")'),
    ).toEqual(["2026-11-01T05:30:00.000Z", "2026-11-01T06:30:00.000Z"]);
    expect(
        dates("Australia/Lord_Howe", 'timestampCandidates("2026-04-05T01:45")'),
    ).toEqual(["2026-04-04T14:45:00.000Z", "2026-04-04T15:15:00.000Z"]);
});
