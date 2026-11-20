export async function discoverTelegramGroups({ client, log = console.log, signal, token = '' }) {
  const me = await client.call('getMe', {}, { signal });
  if (typeof me?.username !== 'string' || !/^[A-Za-z0-9_]+$/.test(me.username)) {
    throw new Error('Telegram returned an invalid bot identity.');
  }
  log(`Bot: @${me.username}`);
  log('Stop every running consumer using this token before discovery. No messages will be sent.');
  const webhook = await client.call('getWebhookInfo', {}, { signal });
  if (webhook?.url) {
    log('An existing webhook is configured. Use a dedicated bot or remove the webhook manually before long polling.');
    return { groups: [], blocked: true };
  }
  log(me.can_read_all_group_messages === true
    ? 'Group privacy is disabled: plain /status can be received.'
    : 'For plain /status, disable group privacy with BotFather /setprivacy, then remove and re-add the bot to the group.');
  log(`Send /status@${me.username} in your group now. Waiting up to 25 seconds for recent group updates...`);
  const updates = await client.call('getUpdates', { timeout: 25, limit: 100, allowed_updates: ['message'] }, { signal });
  if (!Array.isArray(updates)) throw new Error('Telegram returned an invalid update list.');
  const groups = new Map();
  for (const update of updates) {
    const chat = update?.message?.chat;
    if (!chat || !['group', 'supergroup'].includes(chat.type) || !Number.isSafeInteger(chat.id) || chat.id >= 0) continue;
    let title = typeof chat.title === 'string' ? chat.title.replace(/[\r\n\t]/g, ' ') : 'Unnamed group';
    if (token) title = title.replaceAll(token, '[redacted]');
    title = title.slice(0, 120);
    groups.set(String(chat.id), { id: String(chat.id), title });
  }
  for (const group of groups.values()) log(`Group: ${group.title} | TELEGRAM_CHAT_ID=${group.id}`);
  if (!groups.size) log(`No group found. Add the bot, send /status@${me.username}, and run this command again.`);
  else log('Choose your group ID above, set TELEGRAM_ENABLED=true in .env, then restart the consumer.');
  return { groups: [...groups.values()], blocked: false };
}
