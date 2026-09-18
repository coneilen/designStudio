import { parseContract } from "@design-studio/contracts";

const phases = [
  "start",
  "prepare",
  "root-pin",
  "enumeration",
  "directory-pins",
  "file-pins",
  "identity",
  "registration",
  "ancestors",
  "release",
  "end",
];
function object(value: unknown): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid numeric capture.");
}
function keys(value: Record<string, unknown>, names: string[]) {
  if (
    Object.keys(value).length !== names.length ||
    Object.keys(value).some((key) => !names.includes(key))
  )
    throw new Error("Unexpected capture fields.");
}
function number(value: unknown) {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > Number.MAX_SAFE_INTEGER
  )
    throw new Error("Invalid capture number.");
}
export function phaseReport(bytes: Uint8Array, filename: string) {
  if (bytes.length > 16384 || !/^[1-9][0-9]*-[12]\.json$/.test(filename))
    throw new Error("Invalid capture filename or bounds.");
  const value = parseContract(
    "JsonValue",
    Buffer.from(bytes).toString("utf8"),
    "json",
  );
  object(value);
  keys(value, [
    "version",
    "timeOrigin",
    "pid",
    "instance",
    "role",
    "incomplete",
    "exitFallback",
    "samplingErrors",
    "droppedSamples",
    "samples",
    "maxGapMs",
    "ticks",
    "groups",
    "ends",
    "records",
    ...(value.version === 2 ? ["native"] : []),
  ]);
  for (const key of [
    "version",
    "timeOrigin",
    "pid",
    "instance",
    "role",
    "incomplete",
    "exitFallback",
    "samplingErrors",
    "droppedSamples",
    "samples",
    "maxGapMs",
    "ticks",
  ])
    number(value[key]);
  if (
    ![1, 2].includes(Number(value.version)) ||
    ![1, 2].includes(Number(value.instance)) ||
    ![1, 2, 3, 4].includes(Number(value.role)) ||
    ![0, 1].includes(Number(value.incomplete)) ||
    ![0, 1].includes(Number(value.exitFallback)) ||
    filename !== `${value.pid}-${value.instance}.json` ||
    Number(value.samples) > 2048
  )
    throw new Error("Invalid capture identity.");
  if (
    !Array.isArray(value.groups) ||
    value.groups.length > 24 ||
    !Array.isArray(value.ends) ||
    value.ends.length > 16 ||
    !Array.isArray(value.records) ||
    value.records.length > 32
  )
    throw new Error("Capture record bound exceeded.");
  for (const group of value.groups) {
    object(group);
    keys(group, [
      "mode",
      "phase",
      "calls",
      "totalMs",
      "maxMs",
      "count",
      "activeMax",
      "handlesMax",
      ...(value.version === 2
        ? ["rssBytesMax", "cpuUserUs", "cpuSystemUs"]
        : []),
    ]);
    if (
      !["current", "rehash"].includes(String(group.mode)) ||
      !phases.includes(String(group.phase))
    )
      throw new Error("Invalid capture phase.");
    for (const key of [
      "calls",
      "totalMs",
      "maxMs",
      "count",
      "activeMax",
      "handlesMax",
      ...(value.version === 2
        ? ["rssBytesMax", "cpuUserUs", "cpuSystemUs"]
        : []),
    ])
      number(group[key]);
  }
  for (const end of value.ends) {
    object(end);
    keys(end, ["id", "mode", "durationMs", "success"]);
    if (!["current", "rehash"].includes(String(end.mode)))
      throw new Error("Invalid capture mode.");
    for (const key of ["id", "durationMs", "success"]) number(end[key]);
  }
  for (const record of value.records) {
    object(record);
    keys(record, ["kind", "atMs"]);
    if (
      ![
        "claimed",
        "worker-open",
        "worker-opened",
        "worker-failed",
        "verify-start",
        "verify-end",
        "verify-failed",
      ].includes(String(record.kind))
    )
      throw new Error("Invalid marker.");
    number(record.atMs);
  }
  if (value.version === 2) {
    object(value.native);
    keys(value.native, ["samplingErrors", "groups"]);
    number(value.native.samplingErrors);
    if (Number(value.native.samplingErrors) > 0 && value.incomplete !== 1)
      throw new Error("Native timing failure cannot claim complete capture.");
    if (!Array.isArray(value.native.groups) || value.native.groups.length > 5)
      throw new Error("Native timing bound exceeded.");
    const seen = new Set();
    for (const group of value.native.groups) {
      object(group);
      keys(group, ["kind", "calls", "totalMs", "maxMs"]);
      if (
        typeof group.kind !== "string" ||
        !["open", "inspect", "acl", "pin", "hash"].includes(group.kind) ||
        seen.has(group.kind)
      )
        throw new Error("Invalid native timing kind.");
      seen.add(group.kind);
      for (const key of ["calls", "totalMs", "maxMs"]) number(group[key]);
    }
  }
  return value;
}
