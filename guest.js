// Customer page, opened from the table's link / QR code: /t/<code>.
// Menu & order (sent as a request a waiter confirms), call a waiter, complaint, bill, review.
const code = (location.pathname.match(/\/t\/([a-z0-9]+)/i) || [])[1] || new URLSearchParams(location.search).get('t') || '';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let info = null;      // everything from /api/guest/<code>
let tab = 'menu';
let cat = null;
let cart = [];        // [{key,item_id,name,choice,addons:[{id,name,price,choice}],price,qty}]
let orderNote = '';
let reason = null;
let pay = null;
const rate = { food: 0, service: 0, ambience: 0 };
let reviewSent = false;

const store = {
  get(k) { try { return JSON.parse(localStorage.getItem(`lau-${code}-${k}`)); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(`lau-${code}-${k}`, JSON.stringify(v)); } catch { /* private mode */ } },
};

function money(c) {
  const v = Math.abs(c) / 100;
  return `${c < 0 ? '−' : ''}${info?.shop.currency || '$'}${Number.isInteger(v) ? v : v.toFixed(2)}`;
}

let toastTimer;
function toast(msg, bad = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast${bad ? ' bad' : ''}`;
  t.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.style.display = 'none'; }, bad ? 5000 : 3000);
}

// Online page (GitHub Pages): config.js sets window.LAU_CLOUD = { url, key } and the requests go
// through the Supabase mailbox to the café PC. On the café Wi-Fi the page talks to the PC directly.
const CLOUD = window.LAU_CLOUD && window.LAU_CLOUD.url ? window.LAU_CLOUD : null;
let pending = []; // online: requests just sent, until the PC has picked them up (~2 s)
const newRef = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

async function rpc(fn, args) {
  const headers = { apikey: CLOUD.key, 'Content-Type': 'application/json' };
  if (CLOUD.key.startsWith('eyJ')) headers.Authorization = `Bearer ${CLOUD.key}`;
  let res;
  try {
    res = await fetch(`${CLOUD.url.replace(/\/+$/, '')}/rest/v1/rpc/${fn}`, { method: 'POST', headers, body: JSON.stringify(args) });
  } catch {
    throw new Error("Can't reach the café right now. Check your internet connection and try again.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Something went wrong. Please ask a waiter.');
  if (data && data.error) throw new Error(data.error);
  return data;
}

function requestLabel(kind, body) {
  if (kind === 'order') { const n = body.lines.reduce((a, l) => a + l.qty, 0); return `Order · ${n} item${n === 1 ? '' : 's'}`; }
  if (body.type === 'bill') return `Bill · ${body.pay || ''}`;
  if (body.type === 'complaint') return 'Complaint';
  return body.reason || 'Call waiter';
}

// The PC's list of this table's requests + the ones just sent that it hasn't picked up yet.
function withPending(requests) {
  const known = new Set((requests || []).map((r) => r.ref).filter(Boolean));
  pending = pending.filter((p) => !known.has(p.ref) && Date.now() - p.created_at < 90_000);
  return [...pending, ...(requests || [])];
}

async function cloudApi(method, path, body) {
  if (method === 'GET') {
    const data = await rpc(path === '/state' ? 'lau_guest_state' : 'lau_guest_info', { p_code: code });
    if (path === '' && data.enabled === false) throw new Error('The table service is switched off right now. Please ask a waiter.');
    data.requests = withPending(data.requests);
    return data;
  }
  const kind = path === '/order' ? 'order' : path === '/feedback' ? 'feedback' : 'request';
  if (kind === 'request' && body.type === 'complaint' && !String(body.note || '').trim()) throw new Error('Please tell us what went wrong');
  const ref = newRef();
  const sent = await rpc('lau_guest_send', { p_code: code, p_kind: kind, p_payload: { ...body, ref } });
  if (kind !== 'feedback') {
    pending.unshift({ id: ref, ref, type: kind === 'order' ? 'order' : body.type, label: requestLabel(kind, body), status: 'new', created_at: Date.now(), by: null, result: '' });
  }
  info.online = sent.online;
  return { id: ref, bill: info.bill, requests: withPending(info.requests.filter((r) => !r.ref || !pending.some((p) => p.ref === r.ref))) };
}

async function api(method, path, body) {
  if (CLOUD) return cloudApi(method, path, body);
  let res;
  try {
    res = await fetch(`/api/guest/${code}${path}`, {
      method, headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Can't reach the café. Make sure you're connected to the café Wi-Fi.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong. Please ask a waiter.');
  return data;
}

// ---------------------------------------------------------------- Sheet
function openSheet(html) {
  const ov = $('#overlay');
  $('#sheet').innerHTML = `<button class="x" data-close aria-label="Close">✕</button>${html}`;
  ov.hidden = false;
  document.body.style.overflow = 'hidden';
  return $('#sheet');
}
function closeSheet() {
  $('#overlay').hidden = true;
  document.body.style.overflow = '';
}
$('#overlay').addEventListener('click', (e) => { if (e.target.id === 'overlay' || e.target.closest('[data-close]')) closeSheet(); });

// ---------------------------------------------------------------- Menu & cart
const items = () => info.menu?.items || [];
const addonsFor = (item) => (info.menu?.addons || []).filter((a) => a.category_ids.includes(item.category_id) || a.item_ids.includes(item.id));
const cartCount = () => cart.reduce((n, l) => n + l.qty, 0);
const cartTotal = () => cart.reduce((n, l) => n + l.price * l.qty, 0);
const qtyOf = (itemId) => cart.filter((l) => l.item_id === itemId).reduce((n, l) => n + l.qty, 0);
const lineName = (l) => `${l.name}${l.choice ? ` (${l.choice})` : ''}`;
const addonText = (l) => l.addons.map((a) => (a.choice ? `${a.name}: ${a.choice}` : a.name)).join(', ');
const saveCart = () => store.set('cart', { cart, note: orderNote });

function addLine(item, choice = '', addons = []) {
  const key = `${item.id}|${choice}|${addons.map((a) => `${a.id}:${a.choice || ''}`).sort().join(',')}`;
  const found = cart.find((l) => l.key === key);
  if (found) found.qty++;
  else cart.push({ key, item_id: item.id, name: item.name, choice, addons, price: item.price + addons.reduce((n, a) => n + a.price, 0), qty: 1 });
  saveCart();
}

function removeOne(itemId) {
  const l = [...cart].reverse().find((x) => x.item_id === itemId);
  if (!l) return;
  l.qty--;
  if (!l.qty) cart = cart.filter((x) => x !== l);
  saveCart();
}

function drawMenu(el) {
  const m = info.menu;
  if (!cat || !m.categories.some((c) => c.id === cat)) cat = m.categories[0]?.id;
  const list = items().filter((i) => i.category_id === cat);
  el.innerHTML = `
    <div class="chips" id="chips">${m.categories.map((c) => `<button class="chip ${c.id === cat ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}</div>
    <h2>${esc(m.categories.find((c) => c.id === cat)?.name || '')}</h2>
    ${list.map((it) => {
      const q = qtyOf(it.id);
      const options = it.choices.length || addonsFor(it).length;
      return `<div class="item ${it.sold_out ? 'off' : ''}">
        <div class="n"><b>${esc(it.name)}</b>${it.description ? `<i>${esc(it.description)}</i>` : ''}${it.choices.length ? `<i>${esc(it.choices.join(' · '))}</i>` : ''}</div>
        <div class="price">${money(it.price)}</div>
        ${it.sold_out ? '<span class="pill">sold out</span>' : `<div class="qty">${q ? `<button class="qb" data-minus="${it.id}" aria-label="Remove one">−</button><b>${q}</b>` : ''}<button class="qb add" data-plus="${it.id}" data-opts="${options ? 1 : 0}" aria-label="Add">+</button></div>`}
      </div>`;
    }).join('')}
    <p class="small mute center" style="margin-top:18px">Your order goes to a waiter, who comes to confirm it with you before it goes to the kitchen.</p>`;
  el.onclick = (e) => {
    const c = e.target.closest('[data-cat]');
    if (c) { cat = Number(c.dataset.cat); keepPlace(draw); return; }
    const plus = e.target.closest('[data-plus]');
    if (plus) {
      const item = items().find((i) => i.id === Number(plus.dataset.plus));
      if (plus.dataset.opts === '1') return optionsSheet(item);
      addLine(item);
      draw();
      return;
    }
    const minus = e.target.closest('[data-minus]');
    if (minus) { removeOne(Number(minus.dataset.minus)); draw(); }
  };
}

// Switching category: the category bar keeps its place (no jump back to the first category), and
// if the page was scrolled down, the new category starts right under the bar (no jump to the top).
function keepPlace(redraw) {
  const bar = document.querySelector('.chips');
  const left = bar ? bar.scrollLeft : 0;
  const pinned = bar && bar.getBoundingClientRect().top <= 1;
  redraw();
  const nb = document.querySelector('.chips');
  if (!nb) return;
  nb.scrollLeft = left;
  const on = nb.querySelector('.chip.on');
  if (on && (on.offsetLeft < nb.scrollLeft || on.offsetLeft + on.offsetWidth > nb.scrollLeft + nb.clientWidth)) {
    nb.scrollLeft = on.offsetLeft - 16;
  }
  const h = nb.nextElementSibling;
  if (pinned && h) scrollTo({ top: h.getBoundingClientRect().top + scrollY - nb.offsetHeight - 8 });
}

// Items with a choice (e.g. croissant: chocolate / thyme / halloumi) or add-ons (milk, syrup…).
function optionsSheet(item) {
  const addons = addonsFor(item);
  let choice = item.choices.length === 1 ? item.choices[0] : '';
  const picked = new Map(); // addon id -> choice
  const s = openSheet(`<h3>${esc(item.name)}</h3><div class="mute">${money(item.price)}</div>
    ${item.choices.length ? `<div class="lbl">Choose one</div>${item.choices.map((c) => `<label class="optline ${c === choice ? 'on' : ''}"><input type="radio" name="ch" value="${esc(c)}" ${c === choice ? 'checked' : ''}><span class="grow">${esc(c)}</span></label>`).join('')}` : ''}
    ${addons.length ? `<div class="lbl">Extras (optional)</div>${addons.map((a) => `<label class="optline" data-a="${a.id}"><input type="checkbox" value="${a.id}"><span class="grow">${esc(a.name)}</span><span class="price">+${money(a.price)}</span></label>
      ${a.choices.length ? `<select data-ac="${a.id}" hidden>${a.choices.map((c) => `<option>${esc(c)}</option>`).join('')}</select>` : ''}`).join('')}` : ''}
    <button class="btn" data-add>Add to my order · <span id="op">${money(item.price)}</span></button>`);
  const price = () => item.price + [...picked.keys()].reduce((n, id) => n + addons.find((a) => a.id === id).price, 0);
  s.onchange = (e) => {
    if (e.target.name === 'ch') {
      choice = e.target.value;
      $$('input[name=ch]', s).forEach((r) => r.closest('.optline').classList.toggle('on', r.checked));
    }
    if (e.target.type === 'checkbox') {
      const id = Number(e.target.value);
      const sel = $(`[data-ac="${id}"]`, s);
      if (e.target.checked) picked.set(id, sel ? sel.value : '');
      else picked.delete(id);
      e.target.closest('.optline').classList.toggle('on', e.target.checked);
      if (sel) sel.hidden = !e.target.checked;
    }
    if (e.target.dataset.ac) picked.set(Number(e.target.dataset.ac), e.target.value);
    $('#op', s).textContent = money(price());
  };
  $('[data-add]', s).onclick = () => {
    if (item.choices.length && !choice) return toast(`Please choose which ${item.name}`, true);
    addLine(item, choice, [...picked].map(([id, c]) => {
      const a = addons.find((x) => x.id === id);
      return { id, name: a.name, price: a.price, ...(c ? { choice: c } : {}) };
    }));
    closeSheet();
    draw();
    toast(`${item.name} added ✓`);
  };
}

function cartSheet() {
  const render = () => {
    if (!cart.length) { closeSheet(); draw(); return; }
    const s = openSheet(`<h3>Your order</h3><div class="mute small">${esc(info.table.name)}</div>
      <div class="card">${cart.map((l, i) => `<div class="row">
          <div><div>${esc(lineName(l))}</div>${l.addons.length ? `<div class="small mute">+ ${esc(addonText(l))}</div>` : ''}<div class="small price">${money(l.price * l.qty)}</div></div>
          <div class="qty"><button class="qb" data-dec="${i}">−</button><b>${l.qty}</b><button class="qb add" data-inc="${i}">+</button></div></div>`).join('')}
        <div class="row total serif"><span>Total</span><span>${money(cartTotal())}</span></div></div>
      <label class="lbl" for="onote">Anything we should know? (allergies, no sugar…)</label>
      <textarea id="onote" rows="2" maxlength="300">${esc(orderNote)}</textarea>
      <button class="btn" data-send>Send my order to the waiter</button>
      <p class="small mute center">A waiter will come to confirm it with you. Nothing is added to your bill until then.</p>`);
    s.oninput = (e) => { if (e.target.id === 'onote') { orderNote = e.target.value; saveCart(); } };
    s.onclick = async (e) => {
      const inc = e.target.closest('[data-inc]');
      const dec = e.target.closest('[data-dec]');
      if (inc) { cart[inc.dataset.inc].qty++; saveCart(); return render(); }
      if (dec) { const l = cart[dec.dataset.dec]; l.qty--; if (!l.qty) cart.splice(cart.indexOf(l), 1); saveCart(); return render(); }
      const send = e.target.closest('[data-send]');
      if (!send) return;
      send.disabled = true;
      try {
        const r = await api('POST', '/order', {
          note: orderNote,
          lines: cart.map((l) => ({ item_id: l.item_id, qty: l.qty, choice: l.choice, addons: l.addons.map((a) => ({ id: a.id, choice: a.choice })) })),
        });
        Object.assign(info, { bill: r.bill, requests: r.requests });
        cart = []; orderNote = ''; saveCart();
        closeSheet();
        draw();
        toast('Order sent ✓ A waiter is coming to confirm it.');
        watchSoon();
      } catch (err) { send.disabled = false; toast(err.message, true); }
    };
  };
  render();
}

// ---------------------------------------------------------------- Waiter & complaint
const ICONS = [[/water/i, '💧'], [/cutlery|napkin|fork|spoon/i, '🍴'], [/help/i, '🙋'], [/clean/i, '🧹'], [/wrong/i, '⚠️'], [/bill/i, '🧾']];
const iconFor = (r) => (ICONS.find(([re]) => re.test(r)) || [0, '✨'])[1];

function drawWaiter(el) {
  el.innerHTML = `<h2>Call a waiter</h2>
    <p class="mute" style="margin-top:0">Tap what you need and we’ll come to your table.</p>
    <div class="grid">${info.reasons.map((r) => `<button class="opt ${r === reason ? 'on' : ''}" data-r="${esc(r)}"><span>${iconFor(r)}</span>${esc(r)}</button>`).join('')}</div>
    <textarea id="wnote" rows="2" maxlength="300" placeholder="Anything else? (optional)"></textarea>
    <button class="btn" data-call>🔔 Call a waiter</button>
    <div class="card" style="margin-top:22px">
      <b>Something not right?</b>
      <p class="small mute" style="margin:4px 0 0">Tell us here. It goes straight to the manager, and we’ll do our best to fix it.</p>
      <textarea id="cnote" rows="3" maxlength="1000" placeholder="What went wrong?"></textarea>
      <button class="btn alt" data-complain>Send to the manager</button>
    </div>`;
  el.onclick = async (e) => {
    const r = e.target.closest('[data-r]');
    if (r) { reason = reason === r.dataset.r ? null : r.dataset.r; $$('[data-r]', el).forEach((o) => o.classList.toggle('on', o.dataset.r === reason)); return; }
    if (e.target.closest('[data-call]')) {
      const b = e.target.closest('[data-call]');
      b.disabled = true;
      try {
        const res = await api('POST', '/request', { type: 'waiter', reason: reason || 'Call waiter', note: $('#wnote', el).value });
        Object.assign(info, { bill: res.bill, requests: res.requests });
        reason = null;
        toast(res.again ? 'Already on its way ✓' : 'A waiter is on the way ✓');
        draw();
        watchSoon();
      } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    }
    if (e.target.closest('[data-complain]')) {
      const b = e.target.closest('[data-complain]');
      const note = $('#cnote', el).value.trim();
      if (!note) return toast('Please tell us what went wrong', true);
      b.disabled = true;
      try {
        const res = await api('POST', '/request', { type: 'complaint', note });
        Object.assign(info, { bill: res.bill, requests: res.requests });
        toast('Thank you. The manager has your message ✓');
        draw();
        watchSoon();
      } catch (err) { toast(err.message, true); } finally { b.disabled = false; }
    }
  };
}

// ---------------------------------------------------------------- Bill
function drawBill(el) {
  const b = info.bill;
  const methods = info.payment_methods;
  if (!pay || !methods.includes(pay)) pay = methods[0];
  el.innerHTML = `<h2>Your bill</h2>
    <div class="card">${b && b.lines.length ? `${b.lines.map((l) => `<div class="row"><span>${l.qty} × ${esc(l.name)}</span><span class="price">${money(l.total)}</span></div>`).join('')}
      ${b.discount ? `<div class="row mute"><span>Discount</span><span>${money(-b.discount)}</span></div>` : ''}
      <div class="row total serif"><span>Total</span><span>${money(b.total)}</span></div>
`
      : '<div class="mute center" style="padding:12px">Nothing on your table yet.<br>Items appear here once the waiter confirms them.</div>'}</div>
    <div class="serif" style="font-size:18px;margin-top:14px">How would you like to pay?</div>
    <div class="grid" style="margin-top:8px">${methods.map((m) => `<button class="opt ${m === pay ? 'on' : ''}" data-pay="${esc(m)}"><span>${/cash/i.test(m) ? '💵' : /whish/i.test(m) ? '📲' : '💳'}</span>${esc(m)}</button>`).join('')}</div>
    <button class="btn" data-askbill>🧾 Ask for the bill</button>`;
  el.onclick = async (e) => {
    const p = e.target.closest('[data-pay]');
    if (p) { pay = p.dataset.pay; return draw(); }
    const ask = e.target.closest('[data-askbill]');
    if (ask) {
      ask.disabled = true;
      try {
        const res = await api('POST', '/request', { type: 'bill', pay });
        Object.assign(info, { bill: res.bill, requests: res.requests });
        toast(`Bill requested ✓ Paying by ${pay}.`);
        draw();
        watchSoon();
      } catch (err) { toast(err.message, true); ask.disabled = false; }
    }
  };
}

// ---------------------------------------------------------------- Review
function drawReview(el) {
  const insta = info.shop.instagram;
  const follow = insta ? `<a class="follow solid" href="https://www.instagram.com/${esc(insta)}/" target="_blank" rel="noopener">📸 Follow us <b>@${esc(insta)}</b></a>` : '';
  if (reviewSent) {
    el.innerHTML = `<div class="card center"><div style="font-size:40px">🥐</div><div class="serif" style="font-size:24px">Merci !</div>
      <p>Thank you, it means a lot to a small place. On se voit à ${esc(info.shop.name)} !</p>${follow}
      <p class="small mute">Workshops, brunch and news: don’t miss out!</p></div>`;
    return;
  }
  const stars = (k, label) => `<div class="fb"><span>${label}</span><span class="stars" data-k="${k}">${[1, 2, 3, 4, 5].map((n) => `<button data-n="${n}" class="${n <= rate[k] ? 'on' : ''}" aria-label="${n} star${n === 1 ? '' : 's'}">★</button>`).join('')}</span></div>`;
  el.innerHTML = `<h2>How was your visit?</h2>
    <div class="card">
      ${stars('food', 'Food &amp; drinks')}${stars('service', 'Service')}${stars('ambience', 'Ambience')}
      <textarea id="fcomment" rows="3" maxlength="1000" placeholder="Tell us more: what did you love? What could be better?"></textarea>
      <div class="lbl">Stay in touch (optional): we’ll treat you on your birthday 🎂</div>
      <input type="text" id="fname" maxlength="60" placeholder="Your name" autocomplete="name">
      <input type="tel" id="fphone" maxlength="30" placeholder="Phone number" autocomplete="tel">
      <label class="lbl" for="fbday">Your birthday</label><input type="date" id="fbday">
      <button class="btn" data-sendfb>Send</button>
    </div>`;
  el.onclick = async (e) => {
    const st = e.target.closest('.stars button');
    if (st) {
      const k = st.parentElement.dataset.k;
      rate[k] = Number(st.dataset.n);
      $$('button', st.parentElement).forEach((b, i) => b.classList.toggle('on', i < rate[k]));
      return;
    }
    const send = e.target.closest('[data-sendfb]');
    if (!send) return;
    if (!rate.food && !rate.service && !rate.ambience) return toast('Please tap at least one star', true);
    send.disabled = true;
    try {
      await api('POST', '/feedback', { ...rate, comment: $('#fcomment', el).value, name: $('#fname', el).value, phone: $('#fphone', el).value, birthday: $('#fbday', el).value });
      reviewSent = true;
      store.set('reviewed', Date.now());
      draw();
      scrollTo({ top: 0 });
    } catch (err) { toast(err.message, true); send.disabled = false; }
  };
}

// ---------------------------------------------------------------- Status of my requests
const STATUS = {
  new: ['Sent ✓', 'accent'],
  taken: [null, 'ok'],
  done: ['Done', ''],
  declined: ['Not possible', 'danger'],
};
function statusHtml() {
  const recent = (info.requests || []).filter((r) => ['new', 'taken'].includes(r.status) || Date.now() - r.created_at < 20 * 60_000).slice(0, 4);
  if (!recent.length) return '';
  return `<div class="card"><b>Your requests</b>${recent.map((r) => {
    const [text, cls] = STATUS[r.status] || ['', ''];
    const label = r.status === 'taken' ? `${r.by || 'A waiter'} is coming` : text;
    return `<div class="status"><span>${r.type === 'order' ? '🍽️' : r.type === 'bill' ? '🧾' : r.type === 'complaint' ? '💬' : '🔔'}</span>
      <div class="grow"><div>${esc(r.type === 'complaint' ? 'Message to the manager' : r.label)}</div>${r.result ? `<div class="small mute">${esc(r.result)}</div>` : ''}</div>
      <span class="pill ${cls}">${esc(label)}</span></div>`;
  }).join('')}</div>`;
}

// ---------------------------------------------------------------- Page
function draw() {
  const main = $('#main');
  const barLeft = $('.chips')?.scrollLeft || 0; // the category bar keeps its place when the page redraws
  const insta = info.shop.instagram;
  main.innerHTML = `${insta ? `<a class="follow" href="https://www.instagram.com/${esc(insta)}/" target="_blank" rel="noopener">📸 Follow us <b>@${esc(insta)}</b> for workshops, brunch &amp; news</a>` : ''}
    ${info.online === false ? '<div class="card" style="border-color:var(--danger)">⚠️ The café system is not connected right now, so your requests may not arrive. Please call a waiter by hand.</div>' : ''}
    <div id="status">${statusHtml()}</div><section id="tab"></section>
    <div class="foot">${esc(info.shop.name)} · ${esc(info.shop.address || '')}${info.shop.phone ? ` · ${esc(info.shop.phone)}` : ''}</div>`;
  const el = $('#tab');
  if (tab === 'menu') drawMenu(el);
  else if (tab === 'waiter') drawWaiter(el);
  else if (tab === 'bill') drawBill(el);
  else drawReview(el);
  const bar = $('.chips');
  if (bar) bar.scrollLeft = barLeft;
  $$('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.t === tab));
  const n = cartCount();
  $('#cartbar').hidden = !(n && tab === 'menu');
  $('#cq').textContent = `${n} item${n === 1 ? '' : 's'}`;
  $('#ct').textContent = money(cartTotal());
}

$('#nav').onclick = (e) => {
  const b = e.target.closest('[data-t]');
  if (!b) return;
  tab = b.dataset.t;
  draw();
  scrollTo({ top: 0 });
};
$('#cartbar').onclick = cartSheet;

// Keep the bill and "a waiter is coming" up to date: every 5 s while something is pending.
let pollTimer;
function watchSoon() {
  clearTimeout(pollTimer);
  const pending = (info.requests || []).some((r) => ['new', 'taken'].includes(r.status));
  pollTimer = setTimeout(refresh, pending ? 5000 : 20000);
}
async function refresh() {
  if (document.hidden) return watchSoon();
  try {
    const s = await api('GET', '/state');
    const before = JSON.stringify([info.bill, info.requests]);
    Object.assign(info, s);
    // Redraw only the parts that changed (never while the customer is typing).
    if (JSON.stringify([info.bill, info.requests]) !== before) {
      $('#status').innerHTML = statusHtml();
      if (tab === 'bill') drawBill($('#tab'));
    }
  } catch { /* offline for a moment: try again later */ }
  watchSoon();
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && info) refresh(); });

async function start() {
  if (window.LAU_CLOUD && !CLOUD) {
    $('#main').innerHTML = '<div class="card center">This page is not set up yet. Please ask a waiter.</div>';
    return;
  }
  if (!code) {
    $('#main').innerHTML = '<div class="card center">Please scan the QR code on your table.</div>';
    return;
  }
  try {
    info = await api('GET', '');
  } catch (err) {
    $('#main').innerHTML = `<div class="card center"><div style="font-size:34px">📶</div><p>${esc(err.message)}</p><button class="btn" onclick="location.reload()">Try again</button></div>`;
    return;
  }
  document.title = `${info.shop.name} · ${info.table.name}`;
  $('#shop').textContent = info.shop.name;
  $('#tagline').textContent = info.shop.tagline || '';
  $('#tablechip').textContent = info.table.name;
  $('#tablechip').hidden = false;
  $('#nav').hidden = false;
  if (!info.menu) {
    $('[data-t=menu]').hidden = true;
    tab = 'waiter';
  } else {
    const saved = store.get('cart');
    if (saved && Array.isArray(saved.cart)) {
      // Keep only lines still on sale.
      cart = saved.cart.filter((l) => info.menu.items.some((i) => i.id === l.item_id && !i.sold_out));
      orderNote = saved.note || '';
    }
  }
  reviewSent = Date.now() - (store.get('reviewed') || 0) < 3 * 3600_000;
  draw();
  watchSoon();
}
start();
