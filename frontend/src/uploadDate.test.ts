import { describe, expect, it } from "vitest";
import { meetingDateToISO } from "./uploadDate";

describe("meeting date", () => {
  it("leaves unknown dates absent", () =>
    expect(meetingDateToISO("", "Asia/Almaty")).toBeUndefined());
  it("uses the selected zone instead of browser zone", () =>
    expect(meetingDateToISO("2026-09-23T14:30", "Asia/Almaty")).toBe(
      "2026-09-23T09:30:00.000Z",
    ));
  it("handles UTC date boundaries", () =>
    expect(meetingDateToISO("2026-09-23T01:00", "Asia/Qyzylorda")).toBe(
      "2026-09-22T20:00:00.000Z",
    ));
  it("rejects nonexistent daylight saving time", () =>
    expect(() =>
      meetingDateToISO("2026-03-08T02:30", "America/New_York"),
    ).toThrow());
  it("rejects ambiguous daylight saving time", () =>
    expect(() =>
      meetingDateToISO("2026-11-01T01:30", "America/New_York"),
    ).toThrow());
});
