// Revisa cada minuto qué tomas vencieron y envía push a la versión web.
// (El APK no depende de esto: usa alarmas locales del teléfono.)
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMessaging } from 'firebase-admin/messaging';
import { DateTime } from 'luxon';
import { pending, keyOf, shouldNotify } from './schedule.js';

initializeApp();
const db = getFirestore();

export const recordatorios = onSchedule(
  { schedule: 'every 1 minutes', region: 'southamerica-west1', timeZone: 'America/Santiago', memory: '256MiB' },
  async () => {
    const now = Date.now();
    const users = await db.collection('users').where('pushEnabled', '==', true).get();
    await Promise.all(users.docs.map(async u => {
      const d = u.data(), tokens = d.fcmTokens || [];
      if (!tokens.length) return;
      const tz = d.tz || 'America/Santiago';
      const at = (off, h, m) => DateTime.fromMillis(now, { zone: tz }).startOf('day').plus({ days: off }).set({ hour: h, minute: m }).toMillis();
      const [medsSnap, logSnap] = await Promise.all([
        u.ref.collection('meds').get(),
        u.ref.collection('log').where('at', '>', now - 7 * 86400e3).get()
      ]);
      const meds = medsSnap.docs.map(x => ({ id: x.id, ...x.data() }));
      const log = logSnap.docs.map(x => x.data());
      const remind = (d.settings && d.settings.remind) || 30;
      const notified = d.notified || {}, snoozes = d.snoozes || {};
      const due = pending(meds, log, now, at).filter(p => {
        const k = keyOf(p.med.id, p.slot);
        return shouldNotify(k, now, notified[k], snoozes[k], remind);
      });
      if (!due.length) return;

      const hm = t => DateTime.fromMillis(t, { zone: tz }).toFormat('HH:mm');
      const res = await getMessaging().sendEachForMulticast({
        tokens,
        data: {
          title: due.length === 1 ? 'Hora de tu medicamento' : `Tienes ${due.length} tomas pendientes`,
          body: due.map(p => `${p.med.name}${p.med.dose ? ' · ' + p.med.dose : ''} (${hm(p.slot)})`).join('\n'),
          tag: 'pastillero'
        },
        webpush: { headers: { Urgency: 'high', TTL: '1800' } }
      });
      const update = {};
      due.forEach(p => { update['notified.' + keyOf(p.med.id, p.slot)] = now; });
      // limpiar marcas antiguas y tokens inválidos
      Object.keys(notified).forEach(k => { if (now - notified[k] > 2 * 86400e3) update['notified.' + k] = FieldValue.delete(); });
      const bad = res.responses.map((r, i) => (!r.success && /registration-token-not-registered|invalid-registration-token|invalid-argument/.test(r.error?.code || '')) ? tokens[i] : null).filter(Boolean);
      if (bad.length) update.fcmTokens = FieldValue.arrayRemove(...bad);
      await u.ref.update(update);
    }));
  }
);
