import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  resolveProject,
  filterByTimeRange,
  parseCount,
  ProjectNotFoundError,
} from "./index";
import { FathomEvent } from "../schema/v1";

function makeEvent(
  overrides: { event_type: FathomEvent["event_type"] } & Partial<FathomEvent>
): FathomEvent {
  return {
    schema_version: "1.0.0",
    session_id: "sess-001",
    project_dir: "/home/user/projects/myapp",
    timestamp: "2026-04-21T10:00:00Z",
    payload: {},
    ...overrides,
  } as FathomEvent;
}

describe("resolveProject", () => {
  const events = [
    makeEvent({ event_type: "session_start", project_dir: "/home/user/projects/alpha" }),
    makeEvent({ event_type: "session_start", project_dir: "/home/user/projects/beta" }),
    makeEvent({ event_type: "session_start", project_dir: "/work/teamA/alpha" }),
  ];

  it("matches an exact path", () => {
    const r = resolveProject(events, "/home/user/projects/alpha");
    expect(r.label).toBe("/home/user/projects/alpha");
    expect(r.events).toHaveLength(1);
  });

  it("strips trailing slash from query", () => {
    const r = resolveProject(events, "/home/user/projects/alpha/");
    expect(r.events).toHaveLength(1);
  });

  it("matches a unique basename", () => {
    const r = resolveProject(events, "beta");
    expect(r.label).toBe("/home/user/projects/beta");
    expect(r.events).toHaveLength(1);
  });

  it("returns all matches when basename is ambiguous", () => {
    const r = resolveProject(events, "alpha");
    expect(r.events).toHaveLength(2);
    expect(r.label).toContain("alpha");
  });

  it("throws ProjectNotFoundError when nothing matches", () => {
    let err: unknown;
    try {
      resolveProject(events, "doesnotexist");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ProjectNotFoundError);
    const knownDirs = (err as ProjectNotFoundError).knownDirs;
    expect(knownDirs).toContain("/home/user/projects/alpha");
    expect(knownDirs).toContain("/work/teamA/alpha");
  });
});

describe("filterByTimeRange", () => {
  const events = [
    makeEvent({ event_type: "session_start", timestamp: "2026-04-20T10:00:00Z" }),
    makeEvent({ event_type: "session_start", timestamp: "2026-04-21T10:00:00Z" }),
    makeEvent({ event_type: "session_start", timestamp: "2026-04-22T10:00:00Z" }),
  ];

  it("returns all events when no bounds are given", () => {
    expect(filterByTimeRange(events)).toHaveLength(3);
  });

  it("respects --since (inclusive)", () => {
    const r = filterByTimeRange(events, "2026-04-21T00:00:00Z");
    expect(r).toHaveLength(2);
  });

  it("respects --until (inclusive)", () => {
    const r = filterByTimeRange(events, undefined, "2026-04-21T10:00:00Z");
    expect(r).toHaveLength(2);
  });

  it("respects both bounds", () => {
    const r = filterByTimeRange(events, "2026-04-21T00:00:00Z", "2026-04-21T23:59:59Z");
    expect(r).toHaveLength(1);
  });

  it("throws on invalid --since", () => {
    expect(() => filterByTimeRange(events, "not-a-date")).toThrow(/Invalid --since/);
  });

  it("throws on invalid --until", () => {
    expect(() => filterByTimeRange(events, undefined, "garbage")).toThrow(/Invalid --until/);
  });
});

describe("parseCount", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warn = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("returns the default when value is undefined", () => {
    expect(parseCount(undefined, 10)).toBe(10);
    expect(warn).not.toHaveBeenCalled();
  });

  it("parses a valid positive integer", () => {
    expect(parseCount("5", 10)).toBe(5);
  });

  it("falls back to default and warns on NaN", () => {
    expect(parseCount("abc", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back on negative values", () => {
    expect(parseCount("-3", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back on zero", () => {
    expect(parseCount("0", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });

  it("falls back on a float", () => {
    expect(parseCount("3.5", 10)).toBe(10);
    expect(warn).toHaveBeenCalled();
  });
});
