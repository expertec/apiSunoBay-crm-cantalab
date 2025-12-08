import admin from 'firebase-admin';
import { db } from './firebaseAdmin.js';

const sequenceCache = new Map();
const { FieldValue } = admin.firestore;

async function fetchSequenceDefinition(trigger) {
  if (!trigger) return null;
  if (sequenceCache.has(trigger)) {
    return sequenceCache.get(trigger);
  }
  const snap = await db
    .collection('secuencias')
    .where('trigger', '==', trigger)
    .limit(1)
    .get();
  const data = snap.empty ? null : snap.docs[0].data();
  sequenceCache.set(trigger, data);
  return data;
}

export async function getSequenceDefinition(trigger) {
  return fetchSequenceDefinition(trigger);
}

export async function computeSequenceNextRun(sequenceEntry) {
  if (!sequenceEntry?.trigger || !sequenceEntry.startTime) return null;
  const def = await fetchSequenceDefinition(sequenceEntry.trigger);
  const messages = def?.messages;
  if (!Array.isArray(messages) || !messages.length) return null;

  const msg = messages[sequenceEntry.index ?? 0];
  if (!msg) return null;

  const base = new Date(sequenceEntry.startTime).getTime();
  if (Number.isNaN(base)) return null;

  const delayMinutes = Number(msg.delay) || 0;
  return new Date(base + delayMinutes * 60_000);
}

export async function calculateLeadNextRun(secuencias = []) {
  if (!Array.isArray(secuencias) || !secuencias.length) return null;
  let earliest = null;
  for (const seq of secuencias) {
    const nextRun = await computeSequenceNextRun(seq);
    if (nextRun && (!earliest || nextRun < earliest)) {
      earliest = nextRun;
    }
  }
  return earliest;
}

export async function syncLeadNextSequence(leadId, overrideSequences) {
  if (!leadId) return;
  const leadRef = db.collection('leads').doc(leadId);

  let sequences = overrideSequences;
  if (!sequences) {
    const snap = await leadRef.get();
    if (!snap.exists) return;
    sequences = snap.data().secuenciasActivas || [];
  }

  if (!Array.isArray(sequences)) {
    sequences = [];
  }

  const nextRun = await calculateLeadNextRun(sequences);
  const update = {};

  if (nextRun) {
    update.nextSequenceAt = nextRun;
  } else {
    update.nextSequenceAt = FieldValue.delete();
  }

  await leadRef.update(update);
}

export function clearSequenceCache(trigger) {
  if (trigger) {
    sequenceCache.delete(trigger);
  } else {
    sequenceCache.clear();
  }
}
