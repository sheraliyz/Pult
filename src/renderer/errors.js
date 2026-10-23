// Human-readable (Uzbek) explanations for connection errors.

export function describeError(err) {
  const msg = err?.message || '';
  const code = err?.code || '';
  const level = err?.level || '';

  if (level === 'client-authentication' || /authentication methods failed/i.test(msg)) {
    return { title: 'Kirish rad etildi', text: 'Foydalanuvchi nomi, parol yoki kalit noto‘g‘ri.' };
  }
  if (code === 'CANCELLED') return { title: 'Bekor qilindi', text: 'Ulanish to‘xtatildi.' };
  if (code === 'HOSTKEY_REJECTED') {
    return { title: 'Server kaliti tasdiqlanmadi', text: 'Xavfsizlik uchun ulanish to‘xtatildi.' };
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return { title: 'Server topilmadi', text: 'Manzil noto‘g‘ri yoki internet yo‘q.' };
  }
  if (code === 'ECONNREFUSED') {
    return { title: 'Ulanish rad etildi', text: 'Port yopiq yoki SSH xizmati ishlamayapti.' };
  }
  if (code === 'ETIMEDOUT' || level === 'client-timeout' || /timed out/i.test(msg)) {
    return { title: 'Javob kelmadi', text: 'Server javob bermadi. Manzil, port va firewall’ni tekshiring.' };
  }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') {
    return { title: 'Tarmoq mavjud emas', text: 'Serverga yo‘l topilmadi. Internetni tekshiring.' };
  }
  if (code === 'ECONNRESET') return { title: 'Aloqa uzildi', text: 'Server ulanishni yopdi.' };
  if (code === 'NO_KEY') {
    return { title: 'SSH kalit topilmadi', text: '~/.ssh papkasida kalit yo‘q. Server sozlamalarida kalit faylini tanlang.' };
  }
  if (code === 'KEY_READ' || code === 'KEY_PARSE') return { title: 'Kalit bilan muammo', text: msg };
  if (/agent/i.test(msg)) {
    return { title: 'SSH agent javob bermadi', text: 'Windows’da “OpenSSH Authentication Agent” xizmati ishlayotganini tekshiring.' };
  }
  return { title: 'Ulanib bo‘lmadi', text: msg || 'Noma’lum xato.' };
}
