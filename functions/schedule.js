// Lógica de horarios compartida entre la app y la Cloud Function.
// `at(dayOffset, h, m)` devuelve el timestamp (ms) de esa hora local, `dayOffset` días desde hoy.
export const H = 3600e3, MIN = 60e3;

export const keyOf = (medId, slot) => medId + '_' + slot;

export function fixedSlots(med, dayOffset, at) {
  return (med.times || []).map(t => {
    const [h, m] = t.split(':').map(Number);
    return at(dayOffset, h, m);
  }).sort((a, b) => a - b);
}

export function isLogged(log, medId, slot) {
  return log.find(l => l.medId === medId && l.slot === slot);
}

export function nextIntervalSlot(med, log) {
  const last = log.filter(l => l.medId === med.id && !l.archived).sort((a, b) => b.slot - a.slot)[0];
  if (!last) return med.start;
  return (last.status === 'taken' ? last.at : last.slot) + med.interval * H;
}

// Tomas que ya vencieron y no están marcadas (máximo 12 h hacia atrás).
export function pending(meds, log, now, at) {
  const out = [];
  for (const m of meds) {
    if (m.paused) continue;
    if (m.mode === 'fixed') {
      const slots = [...fixedSlots(m, -1, at), ...fixedSlots(m, 0, at)];
      for (const s of slots)
        if (s <= now && s > now - 12 * H && s >= (m.created || 0) - MIN && !isLogged(log, m.id, s)) out.push({ med: m, slot: s });
    } else {
      const s = nextIntervalSlot(m, log);
      if (s && s <= now) out.push({ med: m, slot: s });
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}

// Tomas pendientes o futuras dentro de los próximos `days` días (para programar alarmas locales).
export function upcoming(meds, log, now, at, days) {
  const out = pending(meds, log, now, at);
  const limit = now + days * 24 * H;
  for (const m of meds) {
    if (m.paused) continue;
    if (m.mode === 'fixed') {
      for (let d = 0; d <= days; d++)
        for (const s of fixedSlots(m, d, at))
          if (s > now && s <= limit && !isLogged(log, m.id, s)) out.push({ med: m, slot: s });
    } else {
      const s = nextIntervalSlot(m, log);
      if (s > now && s <= limit) out.push({ med: m, slot: s });
    }
  }
  return out.sort((a, b) => a.slot - b.slot);
}

// ¿Corresponde avisar ahora esta toma? (aviso inicial, repetición o fin de posposición)
export function shouldNotify(key, now, lastNotified, snoozeUntil, remindMin) {
  if (snoozeUntil) {
    if (now < snoozeUntil) return false;
    if (!lastNotified || lastNotified < snoozeUntil) return true;
  }
  return !lastNotified || now - lastNotified >= remindMin * MIN;
}
