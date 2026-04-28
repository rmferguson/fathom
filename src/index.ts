/**
 * Fathom public API
 *
 * This is the library entry point for consumers who import fathom
 * programmatically (e.g., to use the aggregator or schema types directly).
 *
 * CLI usage: fathom <command>
 * Library usage: import { aggregate, readEvents, FathomEvent } from '@aquarium-tools/fathom'
 */

// Schema types — the contract between layers
export {
  SCHEMA_VERSION,
  type EventType,
  type FathomEvent,
  type EventPayload,
  type ToolUsePayload,
  type ToolStartPayload,
  type ToolFailurePayload,
  type SessionStartPayload,
  type SessionEndPayload,
  type NotificationPayload,
  type SubagentPayload,
  type GenericPayload,
} from "./schema/v1";

// Aggregator — reads events.jsonl and computes metrics
export {
  readEvents,
  aggregate,
  defaultSinkPath,
  type SessionSummary,
  type AggregateSummary,
} from "./aggregator";
