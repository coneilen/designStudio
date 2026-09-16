import type {
  ComponentNode,
  ComponentReference,
  ComponentSnapshot,
  DesignNode,
  Diagnostic,
  PropertyDefinition,
  PropertyValue,
  PropertyValues,
} from "@design-studio/contracts";
import { canonicalDigest } from "./canonical.js";
import { namespaceId } from "./identity.js";
import {
  diagnostic,
  fail,
  indexNodes,
  KernelError,
  limitFail,
  own,
  shape,
  unique,
} from "./shared.js";
import { validateAdapter } from "./tokens.js";

const key = (ref: ComponentReference) => canonicalDigest([ref.id, ref.version]);
const equal = (a: unknown, b: unknown) =>
  canonicalDigest(a) === canonicalDigest(b);

function semantics(
  node: DesignNode,
  source: Pick<ComponentNode, "accessibility" | "behavior">,
  defaults = false,
): void {
  if (source.accessibility) {
    if (node.type === "unsupported")
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Unsupported expansion cannot carry editable semantics: ${node.id}`,
      );
    if (!defaults || !node.accessibility)
      node.accessibility = structuredClone(source.accessibility);
  }
  if (source.behavior) {
    switch (node.type) {
      case "frame":
      case "row":
      case "column":
      case "stack":
      case "group":
      case "text":
      case "image":
      case "icon":
      case "shape":
      case "component":
        if (!defaults || !node.behavior)
          node.behavior = structuredClone(source.behavior);
        break;
      default:
        fail(
          "COMPONENT_PROPERTY_INVALID",
          `Expansion root cannot carry behavior: ${node.id}`,
        );
    }
  }
}

function validProperty(
  declaration: PropertyDefinition,
  value: PropertyValue,
): void {
  if (
    value.type !== declaration.type ||
    (declaration.allowedValues &&
      !declaration.allowedValues.some((x) => equal(x, value)))
  )
    fail(
      "COMPONENT_PROPERTY_INVALID",
      `Invalid value/type for component property ${declaration.name}`,
    );
}

function bind(
  node: DesignNode,
  properties: PropertyValues,
  declarations: ReadonlyMap<string, PropertyDefinition>,
  apply: boolean,
): void {
  if (!("bindings" in node)) return;
  const destinations = new Set<string>();
  for (const binding of node.bindings ?? []) {
    if (destinations.has(binding.target))
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Competing visual bindings for ${binding.target}`,
      );
    destinations.add(binding.target);
    const declaration = declarations.get(binding.property);
    const expected =
      binding.target === "appearance.fill"
        ? "color"
        : binding.target === "appearance.opacity"
          ? "number"
          : binding.target.startsWith("accessibility.state.")
            ? "boolean"
            : "string";
    if (!declaration || declaration.type !== expected)
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Binding ${binding.property} has incompatible type for ${binding.target}`,
      );
    if (binding.target === "content" && node.type !== "text")
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Content binding requires text: ${node.id}`,
      );
    if (binding.target.startsWith("accessibility.") && !node.accessibility)
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Accessibility binding lacks declared semantics: ${node.id}`,
      );
    if (!apply) continue;
    const value = own(properties, binding.property);
    if (!value)
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Binding property has no supplied/default value: ${binding.property}`,
      );
    if (
      binding.target === "content" &&
      node.type === "text" &&
      value.type === "string"
    )
      node.content = value.value;
    else if (
      binding.target === "accessibility.label" &&
      node.accessibility &&
      value.type === "string"
    )
      node.accessibility.label = value.value;
    else if (
      binding.target.startsWith("accessibility.state.") &&
      node.accessibility &&
      value.type === "boolean"
    ) {
      node.accessibility.state ??= {};
      if (binding.target === "accessibility.state.checked")
        node.accessibility.state.checked = value.value;
      else node.accessibility.state.disabled = value.value;
    } else if (binding.target === "appearance.fill" && value.type === "color") {
      node.appearance ??= {};
      node.appearance.fill = structuredClone(value.value);
    } else if (
      binding.target === "appearance.opacity" &&
      value.type === "number"
    ) {
      if (value.value < 0 || value.value > 1)
        fail("COMPONENT_PROPERTY_INVALID", "Opacity binding outside [0,1]");
      node.appearance ??= {};
      node.appearance.opacity = value.value;
    }
  }
  delete node.bindings;
}

export interface InstanceExpansion {
  instanceId: string;
  component: ComponentReference;
  mode: "definition" | "snapshot-only";
  properties: PropertyValues;
  variant?: string;
  localIds: Record<string, string>;
  slotIds: Record<string, string[]>;
}

export function expandComponents(
  root: DesignNode,
  snapshot: ComponentSnapshot,
  limits: { maxExpandedNodes: number; maxDepth: number },
): {
  root: DesignNode;
  instances: InstanceExpansion[];
  components: ComponentReference[];
  mappingDiagnostics: Diagnostic[];
} {
  for (const value of [limits.maxExpandedNodes, limits.maxDepth])
    if (!Number.isSafeInteger(value) || value < 1)
      fail(
        "INVALID_INPUT",
        "Expansion budgets must be positive finite integers",
      );
  if (limits.maxDepth > 128)
    fail("INVALID_INPUT", "Maximum supported depth budget is 128");
  shape("DesignNode", root);
  shape("ComponentSnapshot", snapshot);
  indexNodes(root, limits.maxExpandedNodes, limits.maxDepth);
  const definitions = unique(snapshot.definitions, key, "component/version");
  for (const definition of definitions.values()) {
    const properties = unique(
      definition.properties,
      (item) => item.name,
      "property",
    );
    unique(definition.slots, (item) => item.name, "slot");
    unique(definition.variants, (item) => item.id, "variant");
    for (const property of properties.values()) {
      if (property.default) validProperty(property, property.default);
      for (const allowed of property.allowedValues ?? []) {
        if (allowed.type !== property.type)
          fail(
            "COMPONENT_PROPERTY_INVALID",
            `Invalid allowed value: ${property.name}`,
          );
      }
    }
    for (const variant of definition.variants) {
      for (const [name, value] of Object.entries(variant.when)) {
        const declaration = properties.get(name);
        if (!declaration)
          fail(
            "COMPONENT_PROPERTY_INVALID",
            `Unknown variant property ${name}`,
          );
        validProperty(declaration, value);
      }
    }
    for (const expansion of [
      definition.expansion,
      ...definition.variants.map((x) => x.expansion),
    ]) {
      const template = structuredClone(expansion);
      semantics(template, definition, true);
      const nodes = indexNodes(
        template,
        limits.maxExpandedNodes,
        limits.maxDepth,
      );
      const anchors = new Set<string>();
      for (const slot of definition.slots) {
        const anchor = nodes.get(slot.targetNodeId);
        if (
          !anchor ||
          slot.minItems > slot.maxItems ||
          (slot.insertion === "children" && !("children" in anchor)) ||
          (slot.insertion === "replace" && anchor.id === expansion.id) ||
          anchors.has(slot.targetNodeId)
        )
          fail(
            "COMPONENT_SLOT_INVALID",
            `Invalid or ambiguous slot anchor/cardinality ${slot.name}`,
          );
        anchors.add(slot.targetNodeId);
        if (slot.insertion === "replace") {
          const subtree = indexNodes(
            anchor,
            limits.maxExpandedNodes,
            limits.maxDepth,
          );
          if (
            definition.slots.some(
              (other) =>
                other.name !== slot.name && subtree.has(other.targetNodeId),
            )
          )
            fail(
              "COMPONENT_SLOT_INVALID",
              `Replacement slot ${slot.name} discards another slot anchor`,
            );
        }
      }
      for (const node of nodes.values()) {
        bind(structuredClone(node), {}, properties, false);
        if (
          node.type === "component" &&
          !definition.dependencies.components.some(
            (ref) => key(ref) === key(node.componentReference),
          )
        )
          fail(
            "RESOURCE_UNRESOLVED",
            `Undeclared nested component ${node.componentReference.id}`,
          );
      }
    }
  }
  // Validate the entire pinned registry, including unselected variants/declarations.
  const checked = new Map<string, number>();
  const active = new Set<string>();
  function closure(ref: ComponentReference): number {
    const id = key(ref);
    if (active.has(id))
      fail("DEPENDENCY_CYCLE", `Component dependency cycle at ${ref.id}`);
    const cached = checked.get(id);
    if (cached !== undefined) return cached;
    if (active.size >= limits.maxDepth)
      limitFail("DEPTH_LIMIT", active.size + 1, limits.maxDepth);
    const definition = definitions.get(id);
    if (!definition)
      fail("RESOURCE_UNRESOLVED", `Missing component ${ref.id}@${ref.version}`);
    active.add(id);
    let depth = 1;
    for (const child of definition.dependencies.components)
      depth = Math.max(depth, 1 + closure(child));
    if (depth > limits.maxDepth)
      limitFail("DEPTH_LIMIT", depth, limits.maxDepth);
    active.delete(id);
    checked.set(id, depth);
    return depth;
  }
  for (const definition of definitions.values()) closure(definition);
  const mappingDiagnostics: Diagnostic[] = [];
  for (const mapping of snapshot.mappings) {
    try {
      const definition = definitions.get(key(mapping.component));
      if (!definition)
        fail(
          "RESOURCE_UNRESOLVED",
          `Code mapping targets missing component ${mapping.component.id}`,
        );
      for (const variant of mapping.supportedVariants)
        if (!definition.variants.some((x) => x.id === variant))
          fail(
            "COMPONENT_PROPERTY_INVALID",
            `Code mapping targets unknown variant ${variant}`,
          );
      for (const adapter of mapping.adapters) {
        const property = definition.properties.find(
          (x) => x.name === adapter.source,
        );
        if (adapter.kind === "property") {
          if (!property)
            fail(
              "COMPONENT_PROPERTY_INVALID",
              `Unknown adapter property ${adapter.source}`,
            );
          validateAdapter(adapter, property.type);
        } else if (
          adapter.kind === "slot" &&
          !definition.slots.some((x) => x.name === adapter.source)
        )
          fail(
            "COMPONENT_SLOT_INVALID",
            `Unknown adapter slot ${adapter.source}`,
          );
      }
      if (mapping.state !== "approved") {
        const item = diagnostic(
          "MAPPING_STALE",
          `Code mapping ${mapping.id} is ${mapping.state}; it does not supply approved reuse.`,
          "warning",
        );
        item.operations = ["implement", "handoff"];
        mappingDiagnostics.push(item);
      }
    } catch (error) {
      if (!(error instanceof KernelError)) throw error;
      const item = diagnostic(
        "MAPPING_STALE",
        `Code mapping ${mapping.id}: ${error.message}`,
        "warning",
      );
      item.operations = ["implement", "handoff"];
      item.evidenceIds = [...mapping.evidenceIds];
      mappingDiagnostics.push(item);
    }
  }
  const instances: InstanceExpansion[] = [];
  const used = new Map<string, ComponentReference>();
  let count = 0;
  const identities = new Set<string>();
  function visit(
    input: DesignNode,
    depth: number,
    componentStack: string[],
  ): DesignNode {
    if (depth > limits.maxDepth)
      limitFail("DEPTH_LIMIT", depth, limits.maxDepth);
    if (input.type === "component")
      return instance(input, depth, componentStack);
    if ("bindings" in input && input.bindings?.length)
      fail(
        "COMPONENT_PROPERTY_INVALID",
        `Unowned visual bindings on ${input.id}`,
      );
    if (++count > limits.maxExpandedNodes)
      limitFail("NODE_LIMIT", count, limits.maxExpandedNodes);
    if (identities.has(input.id))
      fail("DUPLICATE_NODE_ID", `Expanded identity collision: ${input.id}`, [
        input.id,
      ]);
    identities.add(input.id);
    const node = structuredClone(input);
    if ("children" in node)
      node.children = node.children.map((child) =>
        visit(child, depth + 1, componentStack),
      );
    return node;
  }
  function instance(
    input: ComponentNode,
    depth: number,
    stack: string[],
  ): DesignNode {
    const componentKey = key(input.componentReference);
    if (stack.includes(componentKey))
      fail(
        "DEPENDENCY_CYCLE",
        `Instance dependency cycle: ${input.componentReference.id}`,
      );
    if (stack.length >= limits.maxDepth)
      limitFail("DEPTH_LIMIT", stack.length + 1, limits.maxDepth);
    const definition = definitions.get(componentKey);
    const record: InstanceExpansion = {
      instanceId: input.id,
      component: structuredClone(input.componentReference),
      mode: definition ? "definition" : "snapshot-only",
      properties: {},
      localIds: {},
      slotIds: {},
    };
    let expansion: DesignNode;
    if (!definition) {
      if (!input.snapshotExpansion)
        fail(
          "RESOURCE_UNRESOLVED",
          `Missing visual component ${input.componentReference.id}`,
        );
      if (
        Object.keys(input.properties).length ||
        Object.keys(input.slots).length ||
        input.variant
      )
        fail(
          "COMPONENT_PROPERTY_INVALID",
          `Snapshot-only instance refuses edits: ${input.id}`,
        );
      expansion = structuredClone(input.snapshotExpansion.root);
    } else {
      used.set(componentKey, {
        id: definition.id,
        version: definition.version,
      });
      const declarations = new Map(
        definition.properties.map((x) => [x.name, x]),
      );
      for (const name of Object.keys(input.properties))
        if (!declarations.has(name))
          fail(
            "COMPONENT_PROPERTY_INVALID",
            `Unknown component property ${name}`,
          );
      for (const declaration of definition.properties) {
        const value =
          own(input.properties, declaration.name) ?? declaration.default;
        if (!value && declaration.required)
          fail(
            "COMPONENT_PROPERTY_INVALID",
            `Missing required property ${declaration.name}`,
          );
        if (value) {
          validProperty(declaration, value);
          record.properties[declaration.name] = structuredClone(value);
        }
      }
      const matches = definition.variants.filter((variant) =>
        Object.entries(variant.when).every(
          ([name, value]) =>
            own(record.properties, name) !== undefined &&
            equal(own(record.properties, name), value),
        ),
      );
      const selected = input.variant
        ? definition.variants.find((x) => x.id === input.variant)
        : matches[0];
      if (input.variant && (!selected || !matches.includes(selected)))
        fail(
          "COMPONENT_PROPERTY_INVALID",
          `Variant ${input.variant} does not match typed properties`,
        );
      if (!input.variant && matches.length > 1)
        fail(
          "COMPONENT_PROPERTY_INVALID",
          `Ambiguous matching variants for ${input.id}`,
        );
      if (definition.variants.length && !selected)
        fail(
          "COMPONENT_PROPERTY_INVALID",
          `No declared variant matches ${input.id}; no implicit fallback`,
        );
      if (selected) record.variant = selected.id;
      expansion = structuredClone(selected?.expansion ?? definition.expansion);
      semantics(expansion, definition, true);
      const nodes = indexNodes(expansion);
      for (const node of nodes.values())
        bind(node, record.properties, declarations, true);
      for (const name of Object.keys(input.slots))
        if (!definition.slots.some((x) => x.name === name))
          fail("COMPONENT_SLOT_INVALID", `Unknown slot ${name}`);
      for (const slot of definition.slots) {
        const content = own(input.slots, slot.name) ?? [];
        if (
          content.length < slot.minItems ||
          content.length > slot.maxItems ||
          content.some((node) => !slot.allowedNodeTypes.includes(node.type))
        )
          fail(
            "COMPONENT_SLOT_INVALID",
            `Invalid slot content/cardinality ${slot.name}`,
          );
      }
    }
    const rootLocalId = expansion.id;
    const localNodes = indexNodes(expansion);
    for (const local of localNodes.values()) {
      const original = local.id;
      local.id =
        original === rootLocalId
          ? input.id
          : namespaceId(input.id, ["definition", original]);
      record.localIds[original] = local.id;
    }
    if (definition) {
      for (const slot of definition.slots) {
        const content = structuredClone(own(input.slots, slot.name) ?? []);
        record.slotIds[slot.name] = [];
        for (const child of content) {
          for (const node of indexNodes(child).values()) {
            node.id = namespaceId(input.id, ["slot", slot.name, node.id]);
          }
          record.slotIds[slot.name]?.push(child.id);
        }
        const anchorId = record.localIds[slot.targetNodeId];
        const anchor = [...localNodes.values()].find(
          (node) => node.id === anchorId,
        );
        if (!anchor)
          fail(
            "COMPONENT_SLOT_INVALID",
            `Missing expansion anchor ${slot.name}`,
          );
        if (slot.insertion === "children" && "children" in anchor)
          anchor.children.push(...content);
        else {
          const parent = [...localNodes.values()].find(
            (node) => "children" in node && node.children.includes(anchor),
          );
          if (!parent || !("children" in parent))
            fail(
              "COMPONENT_SLOT_INVALID",
              `Replacement anchor has no structural parent: ${slot.name}`,
            );
          parent.children.splice(
            parent.children.indexOf(anchor),
            1,
            ...content,
          );
        }
      }
    }
    expansion.layout = {
      ...expansion.layout,
      ...structuredClone(input.layout),
    };
    if (expansion.type !== "unsupported" && input.appearance)
      expansion.appearance = {
        ...expansion.appearance,
        ...structuredClone(input.appearance),
      };
    if (input.name !== undefined) expansion.name = input.name;
    if (input.metadata) expansion.metadata = structuredClone(input.metadata);
    if (input.transform) expansion.transform = structuredClone(input.transform);
    semantics(expansion, input);
    instances.push(record);
    return visit(expansion, depth, [...stack, componentKey]);
  }
  return {
    root: visit(root, 1, []),
    instances,
    components: [...used.values()],
    mappingDiagnostics,
  };
}
