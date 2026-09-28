// CoolQuote submission Worker (dev)
// Receives a CoolQuote at /api/submit and emails it to Certech with the photos attached.
// Email goes only to the verified address below, so this Worker can't be used to email anyone else.

const TO = 'certechhvac@gmail.com';
const FROM = 'coolquote@certechservices.net';
const ALLOWED_ORIGINS = ['https://coolquote-dev.certechservices.net'];
const PHOTO_AREAS = { outdoor: 'Outdoor AC unit', indoor: 'Indoor equipment', attic: 'Attic' };
const MAX_PHOTOS_PER_AREA = 5;
const MAX_PHOTO_BYTES = 18 * 1024 * 1024; // total; Cloudflare's limit for verified addresses is 25 MiB per email

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== '/api/submit') return reply(404, 'Not found');
    if (request.method !== 'POST') return reply(405, 'Use POST');

    const origin = request.headers.get('Origin');
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return reply(403, 'Origin not allowed: ' + origin);

    let form;
    try { form = await request.formData(); } catch (e) { return reply(400, 'Could not read the form'); }

    // Hidden field real people never fill in. Bots usually do; pretend it worked and drop it.
    if (String(form.get('website') || '').trim()) return reply(200, 'OK', true);

    let data;
    try { data = JSON.parse(String(form.get('answers') || '')); } catch (e) { return reply(400, 'Answers were missing or unreadable'); }
    const name = clean(data.name, 120);
    const email = clean(data.email, 200);
    const phone = clean(data.phone, 60);
    const fields = Array.isArray(data.fields) ? data.fields.slice(0, 60) : [];
    if (!name || !email || !phone || !fields.length) return reply(400, 'Contact info or answers missing');

    // Collect photos, with limits
    const attachments = [];
    const counts = { outdoor: 0, indoor: 0, attic: 0 };
    let skipped = 0, total = 0;
    for (const [key, value] of form.entries()) {
      if (!key.startsWith('photo_') || typeof value === 'string') continue;
      const area = key.slice(6);
      if (!(area in counts)) continue;
      const type = value.type || '';
      if (!type.startsWith('image/') || counts[area] >= MAX_PHOTOS_PER_AREA || total + value.size > MAX_PHOTO_BYTES) { skipped++; continue; }
      counts[area]++;
      total += value.size;
      const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
      attachments.push({ content: await value.arrayBuffer(), filename: `${area}-${counts[area]}.${ext}`, type, disposition: 'attachment' });
    }

    const photoLines = Object.entries(PHOTO_AREAS).map(([k, label]) => [label + ' photos', String(counts[k])]);
    if (skipped) photoLines.push(['Photos not attached (over the limit)', String(skipped)]);
    const rows = fields
      .filter(r => Array.isArray(r) && r.length === 2)
      .map(([label, value]) => [clean(label, 200), clean(value, 2000)])
      .concat(photoLines);

    const text = `New CoolQuote from ${name}\n\n` + rows.map(([l, v]) => `${l}: ${v || '-'}`).join('\n') +
      `\n\nReply to this email to answer ${name} directly.`;
    const html = `<div style="font-family:Arial,sans-serif;font-size:14px;color:#16283D">
      <h2 style="margin:0 0 4px">New CoolQuote</h2>
      <p style="margin:0 0 16px;color:#4B5D71">${esc(name)} &middot; ${esc(phone)} &middot; ${esc(email)}</p>
      <table cellpadding="8" cellspacing="0" style="border-collapse:collapse;width:100%;max-width:640px">
        ${rows.map(([l, v], i) => `<tr style="background:${i % 2 ? '#fff' : '#F4F7FA'}"><td style="font-weight:bold;vertical-align:top;width:40%">${esc(l)}</td><td style="vertical-align:top;white-space:pre-wrap">${esc(v || '-')}</td></tr>`).join('')}
      </table>
      <p style="color:#4B5D71;margin-top:16px">Photos are attached. Reply to this email to answer ${esc(name)} directly.</p>
    </div>`;

    const message = { to: TO, from: { email: FROM, name: 'CoolQuote' }, subject: `New CoolQuote: ${name}`, text, html, attachments };
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) message.replyTo = email;

    try {
      await env.EMAIL.send(message);
    } catch (e) {
      console.error('CoolQuote email failed', e && e.code, e && e.message);
      return reply(502, 'Email could not be sent' + (e && e.code ? ' (' + e.code + ')' : '') + (e && e.message ? ': ' + e.message : ''));
    }
    return reply(200, 'Sent', true);
  }
};

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max); }
function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function reply(status, message, success = false) {
  return new Response(JSON.stringify({ success, message }), { status, headers: { 'Content-Type': 'application/json' } });
}
