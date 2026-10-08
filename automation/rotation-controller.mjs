// IDs are opaque decimal strings. Never compare visit timestamps as JS dates:
// PostgreSQL records microseconds, and concurrent commits need not be ID-ordered.
const finalizations = new WeakMap();

export function validateEvent(event) {
  if (!event || typeof event.event_id !== 'string' || typeof event.visit_id !== 'string' ||
      !/^[1-9]\d*$/.test(event.event_id) || !/^[1-9]\d*$/.test(event.visit_id) ||
      typeof event.created_at !== 'string' || !Number.isFinite(Date.parse(event.created_at))) {
    throw new Error('Invalid rotation event; refusing to advance');
  }
  return event;
}

export function normalizeState(state) {
  if (!state || ![3, 5].includes(state.version) || ![1, 2, 3].includes(state.currentFolder)) {
    throw new Error('Missing or invalid rotation checkpoint; manual reconciliation required');
  }
  if (state.lastProcessedVisit !== null && typeof state.lastProcessedVisit !== 'string') {
    throw new Error('Invalid legacy visit checkpoint');
  }
  const result = { ...state, version: 5, pending: state.pending || null };
  if (result.pending) {
    validateEvent(result.pending.event);
    if (!['queued', 'publishing', 'published'].includes(result.pending.phase) ||
        ![1, 2, 3].includes(result.pending.folder) ||
        result.pending.folder !== (result.currentFolder % 3) + 1) {
      throw new Error('Invalid pending folder; manual reconciliation required');
    }
  }
  return result;
}

export function validatePublication(receipt, eventId) {
  if (receipt?.ok !== true || receipt.eventId !== eventId || receipt.remoteConfirmed !== true ||
      !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(receipt.revision || '') ||
      receipt.publication?.ok !== true || !Number.isFinite(Date.parse(receipt.publication.checkedAt)) ||
      !/^[a-f0-9]{64}$/.test(receipt.publication.sourceDigest || '')) {
    throw new Error('Publisher confirmation does not match the pending event');
  }
  return receipt;
}

// Dependency injection keeps reliability tests entirely offline. Persist intent
// before publishing, then ACK only after public delivery has been confirmed.
export async function processNextEvent(state, services) {
  const { events, ready, publish, acknowledge, save, now = () => new Date().toISOString() } = services;
  const finalization = finalizations.get(state);
  if (finalization) {
    await save(finalization);
    finalizations.delete(state);
    Object.assign(state, finalization);
    return { processed: true, folder: state.currentFolder, eventId: state.lastProcessedEvent };
  }
  if (!state.pending) {
    const queue = await events();
    if (!Array.isArray(queue)) throw new Error('Invalid queue response');
    if (!queue.length) return { processed: false, reason: 'idle' };
    const event = validateEvent(queue[0]);
    state.pending = { event, folder: (state.currentFolder % 3) + 1, phase: 'queued', queuedAt: now() };
    await save(state);
  }
  const pending = state.pending;
  // On a retry the publisher checks the Git event receipt before reading source
  // files, so committed work can recover even if a user has since changed them.
  if (pending.phase === 'queued') {
    const status = await ready(pending.folder);
    if (!status.ok) return { processed: false, reason: 'folder-not-ready', folder: pending.folder };
    pending.phase = 'publishing';
    await save(state);
  }
  const publication = validatePublication(await publish(pending), pending.event.event_id);
  pending.phase = 'published';
  pending.publication = publication;
  await save(state);
  const acknowledged = await acknowledge(pending.event.event_id);
  if (acknowledged !== true) throw new Error('Rotation acknowledgement not confirmed');

  const completed = {
    ...state,
    currentFolder: pending.folder,
    lastProcessedVisit: pending.event.created_at,
    lastProcessedEvent: pending.event.event_id,
    lastSuccessfulPublication: { ...publication, folder: pending.folder, eventId: pending.event.event_id },
    pending: null,
  };
  try { await save(completed); }
  catch (error) { finalizations.set(state, completed); throw error; }
  Object.assign(state, completed);
  return { processed: true, folder: state.currentFolder, eventId: state.lastProcessedEvent };
}
