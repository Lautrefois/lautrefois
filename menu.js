// View-only menu: the café's menu as it is on the POS right now (prices, options, extras, sold out).
// No ordering. Online it reads the menu the POS publishes to Supabase (config.js); on the café
// Wi-Fi it reads it from the POS directly.
const $ = (s, el = document) => el.querySelector(s);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const CLOUD = window.LAU_CLOUD && window.LAU_CLOUD.url ? window.LAU_CLOUD : null;
let data = null;
let cat = null;

const money = (c) => {
  const v = Math.abs(c) / 100;
  return `${data?.shop?.currency || '$'}${Number.isInteger(v) ? v : v.toFixed(2)}`;
};

async function load() {
  if (CLOUD) {
    const headers = { apikey: CLOUD.key, 'Content-Type': 'application/json' };
    if (CLOUD.key.startsWith('eyJ')) headers.Authorization = `Bearer ${CLOUD.key}`;
    const res = await fetch(`${CLOUD.url.replace(/\/+$/, '')}/rest/v1/rpc/lau_public_menu`, { method: 'POST', headers, body: '{}' });
    if (!res.ok) throw new Error('menu unavailable');
    return res.json();
  }
  const res = await fetch('/api/public-menu');
  if (!res.ok) throw new Error('menu unavailable');
  return res.json();
}

function draw() {
  const m = data.menu || {};
  const cats = (m.categories || []).filter((c) => (m.items || []).some((i) => i.category_id === c.id));
  if (!cats.length) {
    $('#main').innerHTML = '<div class="card center">The menu is being updated. Please come back in a moment.</div>';
    return;
  }
  if (!cat || !cats.some((c) => c.id === cat)) cat = cats[0].id;
  const items = m.items.filter((i) => i.category_id === cat);
  const extras = (m.addons || []).filter((a) => a.category_ids.includes(cat) || items.some((i) => a.item_ids.includes(i.id)));
  const insta = data.shop?.instagram;
  $('#main').innerHTML = `
    ${insta ? `<a class="follow" href="https://www.instagram.com/${esc(insta)}/" target="_blank" rel="noopener">📸 Follow us <b>@${esc(insta)}</b> for workshops, brunch &amp; news</a>` : ''}
    <div class="chips">${cats.map((c) => `<button class="chip ${c.id === cat ? 'on' : ''}" data-cat="${c.id}">${esc(c.name)}</button>`).join('')}</div>
    <h2>${esc(cats.find((c) => c.id === cat).name)}</h2>
    ${items.map((it) => `<div class="item ${it.sold_out ? 'off' : ''}">
      <div class="n"><b>${esc(it.name)}</b>${it.description ? `<i>${esc(it.description)}</i>` : ''}${it.choices.length ? `<i>${esc(it.choices.join(' · '))}</i>` : ''}</div>
      ${it.sold_out ? '<span class="pill">sold out</span>' : `<div class="price">${money(it.price)}</div>`}
    </div>`).join('')}
    ${extras.length ? `<div class="card"><b>Extras</b>${extras.map((a) => {
      const only = a.category_ids.includes(cat) ? '' : ` <span class="small mute">(${esc(items.filter((i) => a.item_ids.includes(i.id)).map((i) => i.name).join(', '))})</span>`;
      return `<div class="row"><span>${esc(a.name)}${only}${a.choices.length ? `<div class="small mute">${esc(a.choices.join(' · '))}</div>` : ''}</span><span class="price">+${money(a.price)}</span></div>`;
    }).join('')}</div>` : ''}
    <div class="foot">${esc(data.shop?.name || '')}${data.shop?.address ? ` · ${esc(data.shop.address)}` : ''}${data.shop?.phone ? ` · ${esc(data.shop.phone)}` : ''}</div>`;
}

$('#main').addEventListener('click', (e) => {
  const c = e.target.closest('[data-cat]');
  if (!c) return;
  cat = Number(c.dataset.cat);
  keepPlace(draw);
});

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

async function refresh(first = false) {
  try {
    const d = await load();
    const changed = JSON.stringify(d) !== JSON.stringify(data);
    data = d;
    if (first) {
      document.title = `${data.shop?.name || "L'Autrefois"} · Menu`;
      if (data.shop?.name) $('#shop').textContent = data.shop.name;
      if (data.shop?.tagline) $('#tagline').textContent = data.shop.tagline;
    }
    if (changed) draw();
  } catch {
    if (first) $('#main').innerHTML = '<div class="card center"><p>The menu can\'t be loaded right now.</p><button class="btn" onclick="location.reload()">Try again</button></div>';
  }
}
refresh(true);
// Keep it current while the page is open (prices, sold out).
setInterval(() => { if (!document.hidden) refresh(); }, 60_000);
