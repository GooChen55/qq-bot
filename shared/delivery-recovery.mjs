// Retry only failures that prove a connection was never established. A read/ack
// timeout may mean delivery succeeded; retrying it could duplicate a message.
export function isConnectFailure(error) {
  return /Connect Timeout Error|UND_ERR_CONNECT_TIMEOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/.test(String(error?.message ?? error));
}

export async function retryConnectFailure(send, { attempts = 3, wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    try { return await send(); }
    catch (error) {
      if (attempt >= attempts || !isConnectFailure(error)) throw error;
      log(`连接未建立，重试发送 ${attempt}/${attempts - 1}`);
      await wait(attempt * 500);
    }
  }
}

export function refreshPendingReplyContext(batches, input) {
  if (!input.eventId || !input.targetId) throw new Error('继续玩法需要当前消息的回复凭据');
  for (const batch of batches) {
    batch.replyContext = { targetId: input.targetId, msgId: input.eventId };
    batch.error = null;
  }
}
