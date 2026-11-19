// In-process event bus behind the realtime layer. Events are thin "pokes": they
// name what changed and clients re-fetch over REST, so authorization and message
// de-duplication live in one place. Single-process by design; to scale out,
// swap this module for Redis pub/sub or Postgres LISTEN/NOTIFY.
import { EventEmitter } from "node:events";

export type ChatEvent =
  | { type: "message"; conversationId: number } // a message was stored
  | { type: "meta"; conversationId: number }; // status / flags / reference changed

const emitter = new EventEmitter();
emitter.setMaxListeners(0); // one listener per live socket

export function publish(event: ChatEvent): void {
  emitter.emit("chat", event);
}

export function subscribe(handler: (event: ChatEvent) => void): () => void {
  emitter.on("chat", handler);
  return () => emitter.off("chat", handler);
}
