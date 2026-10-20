// @ts-check
// What a refused save means for the person. The worker answers with a code; a field it does not know means the
// worker was loaded before the page and runs an older schema, so only a reload of the extension helps.

/** @typedef {{ ok?: boolean, code?: string } | null | undefined} SaveReply */

/**
 * @param {SaveReply} reply
 * @returns {'reload' | 'generic'}
 */
export function saveErrorKind(reply) {
  return reply && reply.ok !== true && reply.code === 'unknown-field' ? 'reload' : 'generic';
}

/**
 * A failure that may pass by itself: no answer, or the worker restarting. A refusal for the content of the change will
 * not.
 * @param {SaveReply} reply
 */
export function isTransient(reply) {
  return !reply || (reply.ok !== true && reply.code === 'error');
}

/**
 * Send, and send once more after a short pause when the first try failed for a reason that may pass.
 * @param {() => Promise<SaveReply>} send
 * @param {number} [delayMs]
 * @returns {Promise<SaveReply>}
 */
export async function sendWithRetry(send, delayMs = 400) {
  /** @type {SaveReply} */
  let reply = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      reply = await send();
    } catch {
      reply = null;
    }
    if (reply?.ok === true || !isTransient(reply)) return reply;
    if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
  }
  return reply;
}
