export const TOPICS = Object.freeze({
  transmit: 'transmit/data',
  transmit_status: 'transmit/status',
  command: 'transmit/command/ack',
  receive: 'receive/state',
  receive_status: 'receive/status',
  weather: 'api/weather',
});

export const COMMAND_TOPIC = 'transmit/command';
export const SUBSCRIPTIONS = Object.values(TOPICS);

const aliases = new Map([
  ...Object.entries(TOPICS),
  ...SUBSCRIPTIONS.map((topic) => [topic, topic]),
  ['command/ack', TOPICS.command],
  ['receive/ack', TOPICS.receive],
]);

export function resolveTopic(query) {
  return aliases.get(query.trim().toLowerCase()) ?? null;
}
