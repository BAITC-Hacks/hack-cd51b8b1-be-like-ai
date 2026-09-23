import { afterEach, describe, expect, it, vi } from "vitest";
import {
  api,
  ApiError,
  normalizeApiBase,
  parseApiError,
  USE_MOCKS,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("API configuration and errors", () => {
  it("uses a same-origin API by default and accepts origins and explicit bases", () => {
    expect(normalizeApiBase()).toBe("/api");
    expect(normalizeApiBase("  /api/ ")).toBe("/api");
    expect(normalizeApiBase("https://backend.example")).toBe(
      "https://backend.example/api",
    );
    expect(normalizeApiBase("https://backend.example/v2/api/")).toBe(
      "https://backend.example/v2/api",
    );
    expect(() =>
      normalizeApiBase("https://user:password@backend.example"),
    ).toThrow(ApiError);
    expect(() => normalizeApiBase("javascript:alert(1)")).toThrow(ApiError);
  });

  it("retains application messages and codes", () => {
    const error = parseApiError(
      { error: { code: "MODEL_UNAVAILABLE", message: "Модель ещё не готова" } },
      503,
    );
    expect(error.message).toBe("Модель ещё не готова");
    expect(error.code).toBe("MODEL_UNAVAILABLE");
    expect(error.status).toBe(503);
  });

  it("renders FastAPI validation fields without losing individual issues", () => {
    const error = parseApiError(
      {
        detail: [
          { loc: ["body", "title"], msg: "Field required" },
          { loc: ["body", "file"], msg: "Unsupported format" },
        ],
      },
      422,
    );
    expect(error.message).toBe(
      "Название: Field required\nФайл: Unsupported format",
    );
    expect(parseApiError({ detail: "Not ready" }, 409).message).toBe(
      "Not ready",
    );
  });

  it("handles a proxy HTML error with a readable fallback", () => {
    expect(parseApiError("<html>Bad gateway</html>", 502).message).toContain(
      "Backend пока недоступен",
    );
  });

  it.skipIf(USE_MOCKS)(
    "never returns demo data when the real network fails",
    async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
      );
      await expect(api.listMeetings()).rejects.toMatchObject({
        code: "NETWORK_ERROR",
      });
    },
  );

  it.skipIf(USE_MOCKS)(
    "preserves cancellation rather than reporting a connection error",
    async () => {
      const controller = new AbortController();
      controller.abort();
      const cancelled = new DOMException("Aborted", "AbortError");
      vi.stubGlobal("fetch", vi.fn().mockRejectedValue(cancelled));
      await expect(api.getMeeting("example", controller.signal)).rejects.toBe(
        cancelled,
      );
    },
  );

  it.skipIf(USE_MOCKS)(
    "preserves cancellation while reading the response body",
    async () => {
      const cancelled = new DOMException("Aborted", "AbortError");
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue({
            ok: true,
            status: 200,
            json: () => Promise.reject(cancelled),
          }),
      );
      await expect(api.listMeetings()).rejects.toBe(cancelled);
    },
  );

  it.skipIf(USE_MOCKS)(
    "rejects a proxy page instead of downloading it as a protocol",
    async () => {
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValue(
            new Response("<html>Frontend fallback</html>", {
              headers: { "Content-Type": "text/html" },
            }),
          ),
      );
      await expect(api.downloadExport("example", "pdf")).rejects.toMatchObject({
        code: "INVALID_EXPORT",
      });
    },
  );

  it.skipIf(USE_MOCKS)(
    "omits unknown meeting dates from multipart uploads",
    async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ meeting_id: "id", status: "queued" }), {
            status: 202,
          }),
        );
      vi.stubGlobal("fetch", fetchMock);
      await api.createMeeting({
        file: new File(["audio"], "meeting.wav", { type: "audio/wav" }),
        title: "Встреча",
        timezone: "Asia/Almaty",
        participants_notified: true,
      });
      const body = fetchMock.mock.calls[0][1].body as FormData;
      expect(body.has("started_at")).toBe(false);
      expect(body.get("participants_notified")).toBe("true");
    },
  );
});
