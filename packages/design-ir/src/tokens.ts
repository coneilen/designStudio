import type {
  Dimension,
  Paint,
  PropertyValue,
  Shadow,
  TokenSnapshot,
  TypedAdapter,
  Typography,
} from "@design-studio/contracts";
import { canonicalDigest } from "./canonical.js";
import { fail, limitFail, own, shape, unique } from "./shared.js";

export interface ValueResolver {
  value(id: string, expected: PropertyValue["type"]): PropertyValue;
  dimension(value: Dimension, signed?: boolean): number;
  paint(value: Paint): Exclude<Paint, { token: string }>;
  shadow(value: Shadow): Shadow;
  typography(value: Typography): Typography;
}

export function valueResolver(
  get: (id: string) => PropertyValue,
): ValueResolver {
  const resolver: ValueResolver = {
    value(id, expected) {
      const value = get(id);
      if (value.type !== expected)
        fail(
          "TOKEN_TYPE_MISMATCH",
          `Token ${id}: expected ${expected}, got ${value.type}`,
        );
      return value;
    },
    dimension(value, signed = false) {
      const resolved =
        typeof value === "number"
          ? value
          : resolver.value(value.token, "dimension").value;
      if (
        typeof resolved !== "number" ||
        !Number.isFinite(resolved) ||
        (!signed && resolved < 0)
      )
        fail(
          "INVALID_LAYOUT",
          "Invalid dimension; expected a finite nonnegative design-unit length",
        );
      return resolved;
    },
    paint(value) {
      if ("token" in value) {
        const resolved = resolver.value(value.token, "color");
        if (resolved.type !== "color")
          fail("TOKEN_TYPE_MISMATCH", "Expected color");
        return structuredClone(resolved.value);
      }
      return structuredClone(value);
    },
    shadow(value) {
      return {
        ...value,
        offset: { ...value.offset },
        blur: resolver.dimension(value.blur),
        spread: resolver.dimension(value.spread, true),
        color: resolver.paint(value.color),
      };
    },
    typography(value) {
      let source = value;
      if (value.styleToken) {
        const resolved = resolver.value(value.styleToken.token, "typography");
        if (resolved.type !== "typography")
          fail("TOKEN_TYPE_MISMATCH", "Expected typography");
        const { styleToken: _styleToken, ...literal } = value;
        // The complete literal declaration is the accepted snapshot of a style token.
        if (
          canonicalDigest(resolver.typography(literal)) !==
          canonicalDigest(resolved.value)
        )
          fail(
            "TOKEN_TYPE_MISMATCH",
            `Typography snapshot disagrees with ${value.styleToken.token}`,
          );
        source = resolved.value;
      }
      const { styleToken: _styleToken, ...literal } = source;
      return {
        ...literal,
        fontSize: resolver.dimension(source.fontSize),
        lineHeight: resolver.dimension(source.lineHeight),
        letterSpacing: resolver.dimension(source.letterSpacing, true),
        color: resolver.paint(source.color),
      };
    },
  };
  return resolver;
}

export function validateAdapter(adapter: TypedAdapter, expected: string): void {
  if (adapter.sourceType !== expected)
    fail(
      "TOKEN_TYPE_MISMATCH",
      `Adapter ${adapter.source}: incompatible source type`,
    );
  if (
    adapter.conversion === "design-unit-to-target-unit" &&
    (expected !== "dimension" || !adapter.targetUnit)
  )
    fail(
      "TOKEN_TYPE_MISMATCH",
      "Unit conversion requires a dimension and explicit target unit",
    );
  if (
    adapter.conversion === "enum-map" &&
    (!adapter.enumMap || Object.keys(adapter.enumMap).length === 0)
  )
    fail("TOKEN_TYPE_MISMATCH", "Enum adapter needs an explicit map");
}

export function resolveTokens(snapshot: TokenSnapshot): {
  values: Map<string, PropertyValue>;
  snapshot: TokenSnapshot;
  resolver: ValueResolver;
} {
  shape("TokenSnapshot", snapshot);
  const definitions = unique(snapshot.definitions, (item) => item.id, "token");
  const collections = unique(
    snapshot.collections,
    (item) => item.id,
    "collection",
  );
  for (const [id, selected] of Object.entries(snapshot.selectedModes)) {
    if (!collections.get(id)?.modes.includes(selected))
      fail("TOKEN_MODE_MISSING", `Unknown collection/mode ${id}/${selected}`);
  }
  for (const collection of collections.values()) {
    unique(collection.modes, (x) => x, "mode");
    if (!own(snapshot.selectedModes, collection.id))
      fail("TOKEN_MODE_MISSING", `Missing selected mode for ${collection.id}`);
  }
  for (const token of definitions.values()) {
    const collection = collections.get(token.collection);
    if (!collection)
      fail("TOKEN_MODE_MISSING", `Missing collection ${token.collection}`);
    for (const mode of collection.modes)
      if (!own(token.values, mode))
        fail(
          "TOKEN_MODE_MISSING",
          `Token ${token.id} lacks declared mode ${mode}`,
        );
    for (const [mode, value] of Object.entries(token.values)) {
      if (!collection.modes.includes(mode))
        fail("TOKEN_MODE_MISSING", `Undeclared mode ${mode}`);
      if (value.type !== "alias" && value.type !== token.type)
        fail(
          "TOKEN_TYPE_MISMATCH",
          `Token ${token.id} type ${token.type} disagrees with ${value.type}`,
        );
      if (
        value.type === "alias" &&
        definitions.get(value.token)?.type !== token.type
      )
        fail(
          "TOKEN_TYPE_MISMATCH",
          `Alias ${token.id} targets a missing/incompatible token ${value.token}`,
        );
    }
  }
  function edges(value: PropertyValue): string[] {
    const refs: string[] = [];
    const add = (
      value: Dimension | Paint | Shadow | undefined,
      expected: PropertyValue["type"],
    ) => {
      if (value && typeof value === "object" && "token" in value) {
        const target = definitions.get(value.token);
        if (!target || target.type !== expected)
          fail(
            "TOKEN_TYPE_MISMATCH",
            `Missing/incompatible composite token ${value.token}`,
          );
        refs.push(value.token);
      }
    };
    if (value.type === "typography") {
      add(value.value.fontSize, "dimension");
      add(value.value.lineHeight, "dimension");
      add(value.value.letterSpacing, "dimension");
      add(value.value.color, "color");
      add(value.value.styleToken, "typography");
    } else if (value.type === "shadow") {
      add(value.value.blur, "dimension");
      add(value.value.spread, "dimension");
      add(value.value.color, "color");
    }
    return refs;
  }
  let graphVisits = 0;
  function checkModes(
    id: string,
    selection: Map<string, string>,
    active: Set<string>,
  ): void {
    if (active.has(id))
      fail("DEPENDENCY_CYCLE", `Token mode graph cycle at ${id}`);
    if (active.size >= 128) limitFail("DEPTH_LIMIT", active.size + 1, 128);
    if (++graphVisits > 20_000) limitFail("NODE_LIMIT", graphVisits, 20_000);
    const token = definitions.get(id);
    if (!token) fail("RESOURCE_UNRESOLVED", `Missing token ${id}`);
    const selected = selection.get(token.collection);
    const modes = selected
      ? [selected]
      : (collections.get(token.collection)?.modes ?? []);
    for (const mode of modes) {
      const value = own(token.values, mode);
      if (!value)
        fail("TOKEN_MODE_MISSING", `Missing token mode ${id}/${mode}`);
      const next = new Map(selection);
      next.set(token.collection, mode);
      const nextActive = new Set(active);
      nextActive.add(id);
      const refs = value.type === "alias" ? [value.token] : edges(value);
      for (const target of refs) checkModes(target, next, nextActive);
    }
  }
  for (const id of definitions.keys()) checkModes(id, new Map(), new Set());
  const values = new Map<string, PropertyValue>();
  const chains = new Map<string, string[]>();
  const active = new Set<string>();
  function get(id: string): PropertyValue {
    const cached = values.get(id);
    if (cached) return cached;
    if (active.has(id))
      fail("DEPENDENCY_CYCLE", `Token cycle: ${[...active, id].join(" -> ")}`);
    if (active.size >= 128) limitFail("DEPTH_LIMIT", active.size + 1, 128);
    const definition = definitions.get(id);
    if (!definition) fail("RESOURCE_UNRESOLVED", `Missing token ${id}`);
    const mode = own(snapshot.selectedModes, definition.collection);
    const raw = mode ? own(definition.values, mode) : undefined;
    if (!raw) fail("TOKEN_MODE_MISSING", `Missing mode value for token ${id}`);
    active.add(id);
    let value: PropertyValue;
    if (raw.type === "alias") {
      value = structuredClone(get(raw.token));
      chains.set(id, [raw.token, ...(chains.get(raw.token) ?? [])]);
    } else if (raw.type === "typography")
      value = { type: "typography", value: resolver.typography(raw.value) };
    else if (raw.type === "shadow")
      value = { type: "shadow", value: resolver.shadow(raw.value) };
    else value = structuredClone(raw);
    if (value.type !== definition.type)
      fail("TOKEN_TYPE_MISMATCH", `Token ${id} type mismatch`);
    active.delete(id);
    values.set(id, value);
    return value;
  }
  const resolver = valueResolver(get);
  for (const id of definitions.keys()) get(id);
  const resolved: TokenSnapshot["resolved"] = [...definitions.values()].map(
    (token) => ({
      tokenId: token.id,
      mode: snapshot.selectedModes[token.collection] ?? "",
      status: "resolved",
      value: get(token.id),
      aliasChain: chains.get(token.id) ?? [],
    }),
  );
  unique(snapshot.resolved, (item) => item.tokenId, "token resolution");
  for (const recorded of snapshot.resolved) {
    const actual = resolved.find((item) => item.tokenId === recorded.tokenId);
    if (!actual || canonicalDigest(recorded) !== canonicalDigest(actual))
      fail(
        "TOKEN_TYPE_MISMATCH",
        `Recorded token resolution disagrees with selected snapshot: ${recorded.tokenId}`,
      );
  }
  for (const mapping of snapshot.adapters) {
    const token = definitions.get(mapping.tokenId);
    if (
      !token ||
      mapping.adapter.source !== token.id ||
      mapping.adapter.kind !== "token"
    )
      fail("RESOURCE_UNRESOLVED", `Invalid token adapter ${mapping.tokenId}`);
    validateAdapter(mapping.adapter, token.type);
    if (
      mapping.state === "approved" &&
      (!mapping.reviewer || !mapping.approvalRevision || !mapping.repository)
    )
      fail(
        "APPROVAL_REQUIRED",
        `Approved token adapter ${mapping.tokenId} lacks approval context`,
      );
  }
  return {
    values,
    resolver,
    snapshot: { ...structuredClone(snapshot), resolved },
  };
}

export function literalTokenCandidates(
  value: PropertyValue,
  values: ReadonlyMap<string, PropertyValue>,
): {
  state: "proposed";
  tokenId: string;
}[] {
  const digest = canonicalDigest(value);
  return [...values]
    .filter(([, candidate]) => canonicalDigest(candidate) === digest)
    .map(([tokenId]) => ({ state: "proposed" as const, tokenId }))
    .sort((a, b) => (a.tokenId < b.tokenId ? -1 : 1));
}
