import { TOPICS, SUBSCRIPTIONS } from './topics.js';
import { normalizePayload } from './schemas.js';

export class TelemetryStore {
  #buffers = new Map(SUBSCRIPTIONS.map((topic) => [topic, []]));
  #metadata = new Map();

  constructor({ limit = 100 } = {}) {
    this.limit = limit;
  }

  record(topic, payload, now = Date.now(), { retained = false } = {}) {
    if (!this.#buffers.has(topic)) return null;
    const normalized = normalizePayload(topic, payload);
    const buffer = this.#buffers.get(topic);
    buffer.push(normalized.data);
    if (buffer.length > this.limit) buffer.splice(0, buffer.length - this.limit);
    this.#metadata.set(topic, {
      received_at: new Date(now).toISOString(),
      schema_valid: normalized.valid,
      retained,
    });
    return normalized;
  }

  has(topic) {
    return (this.#buffers.get(topic)?.length ?? 0) > 0;
  }

  latest(topic) {
    return this.#buffers.get(topic)?.at(-1) ?? null;
  }

  history(topic) {
    return [...(this.#buffers.get(topic) ?? [])];
  }

  snapshot() {
    return {
      ...Object.fromEntries(Object.entries(TOPICS).map(([key, topic]) => [key, this.latest(topic)])),
      metadata: Object.fromEntries(Object.entries(TOPICS)
        .map(([key, topic]) => [key, this.#metadata.get(topic) ?? null])),
    };
  }
}
