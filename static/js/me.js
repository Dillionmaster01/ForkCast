// Goals per person, how the days went, the household, and settings.
import { S, api, esc, $, $$, openSheet, confirmSheet, toast, fail, icon, avatar, fmtK, todayIso, addDays, fmtShort, dowName, render, signOut, lsSet, applyTheme, loadUsers } from './app.js';

let range = 14;
let who = null;

function ring(pct, label, sub, color) {
  const r = 32;
  const c = 2 * Math.PI * r;
  const p = Math.max(0, Math.min(1, pct));
  return `<svg class="ring" viewBox="0 0 76 76"><circle cx="38" cy="38" r="${r}" fill="none" stroke="var(--surface-3)" stroke-width="8"/>
    <circle cx="38" cy="38" r="${r}" fill="none" stroke="${color}" stroke-width="8" stroke-linecap="round" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 38 38)"/>
    <text x="38" y="38" text-anchor="middle" font-size="15">${esc(label)}</text><text x="38" y="52" text-anchor="middle" font-size="9" style="fill:var(--muted);font-weight:700">${esc(sub)}</text></svg>`;
}

function chart(p, days) {
  // drawn at the size it shows, so labels stay readable on a phone
  const W = Math.round(Math.min(900, Math.max(300, window.innerWidth - (window.innerWidth >= 900 ? 300 : 66))));
  const H = 200;
  const padL = 34;
  const padB = 22;
  const goal = p.goals.kcal;
  const top = Math.max(goal || 0, ...p.series.map((s) => s.eaten.kcal + s.planned.kcal), 500) * 1.1;
  const step = [250, 500, 1000, 1500, 2000, 2500, 5000].find((st) => top / st <= 4) || 5000;
  const max = Math.ceil(top / step) * step;
  const bw = (W - padL - 6) / days.length;
  const y = (v) => H - padB - (v / max) * (H - padB - 8);
  const today = todayIso();
  const ticks = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);
  let out = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Calories per day">`;
  for (const t of ticks) out += `<line class="axis" x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}"/><text class="lbl" x="${padL - 5}" y="${y(t) + 3}" text-anchor="end">${t >= 1000 ? (t / 1000).toFixed(1) + 'k' : t}</text>`;
  p.series.forEach((s, i) => {
    const x = padL + i * bw + bw * 0.18;
    const w = bw * 0.64;
    const e = s.eaten.kcal;
    const pl = s.date >= today ? s.planned.kcal : 0;
    const over = goal && e > goal;
    if (e) out += `<rect class="e ${over ? 'over' : ''}" x="${x}" y="${y(e)}" width="${w}" height="${Math.max(0, y(0) - y(e))}" rx="3"><title>${fmtShort(s.date)}: ${fmtK(e)} kcal eaten</title></rect>`;
    if (pl) out += `<rect class="p" x="${x}" y="${y(e + pl)}" width="${w}" height="${Math.max(0, y(e) - y(e + pl))}" rx="3"><title>${fmtShort(s.date)}: ${fmtK(pl)} kcal planned</title></rect>`;
    if (days.length <= (W < 500 ? 7 : 14) || i % Math.ceil(days.length / (W < 500 ? 7 : 12)) === 0) out += `<text class="lbl" x="${x + w / 2}" y="${H - 7}" text-anchor="middle">${days.length <= 7 ? dowName(s.date) : Number(s.date.slice(8, 10))}</text>`;
  });
  if (goal) out += `<line class="goal" x1="${padL}" x2="${W}" y1="${y(goal)}" y2="${y(goal)}"/><text class="lbl" x="${W - 4}" y="${y(goal) - 4}" text-anchor="end" style="fill:var(--accent)">goal ${fmtK(goal)}</text>`;
  return out + '</svg>';
}

export async function renderMe(mount) {
  await loadUsers();
  const today = todayIso();
  const from = addDays(today, -(range - 1));
  const stats = await api('GET', `/api/stats?from=${from}&to=${addDays(today, 1)}`);
  if (!who || !S.users.some((u) => u.id === who)) who = S.me.id;
  const person = stats.people.find((p) => p.id === who) || stats.people[0];
  const days = stats.days.filter((d) => d <= today);
  const series = { ...person, series: person.series.filter((s) => s.date <= today) };

  mount.innerHTML = `<div class="pagehead"><h1>Goals & progress</h1></div>
    <div class="people">${stats.people.map((p) => {
      const t = p.series.find((s) => s.date === today) || { eaten: { kcal: 0 }, planned: { kcal: 0 } };
      const goal = p.goals.kcal;
      const canEdit = p.id === S.me.id || S.me.isAdmin;
      return `<div class="card pad"><div class="row" style="align-items:flex-start;gap:14px">
        ${ring(goal ? t.eaten.kcal / goal : 0, fmtK(t.eaten.kcal), goal ? `of ${fmtK(goal)}` : 'today', p.color)}
        <div class="grow"><div class="row"><h2 style="font-size:20px" class="grow">${esc(p.name)}</h2>${canEdit ? `<button class="btn sm" data-goals="${esc(p.id)}">${icon('edit')}Goals</button>` : ''}</div>
        <div class="small muted" style="margin-top:2px">Today: ${fmtK(t.eaten.kcal)} eaten${t.planned.kcal ? ` · ${fmtK(t.planned.kcal)} still planned` : ''}</div>
        <div class="small" style="margin-top:6px">${p.daysLogged ? `<b class="num">${fmtK(p.avgKcal)}</b> kcal average over ${p.daysLogged} logged day${p.daysLogged === 1 ? '' : 's'}` : '<span class="muted">Nothing logged in this range yet.</span>'}
          ${goal && p.daysLogged ? `<br><span class="muted">${p.daysOverGoal} of ${p.daysLogged} days over the goal</span>` : ''}</div>
        <div class="row wrap small muted" style="margin-top:6px;gap:10px">${['protein', 'carbs', 'fat'].map((k) => (p.goals[k] ? `<span>${k} goal ${p.goals[k]} g</span>` : '')).join('')}</div>
        </div></div></div>`;
    }).join('')}</div>

    <div class="card pad" style="margin-top:14px">
      <div class="row wrap" style="margin-bottom:8px"><h2 style="font-size:19px" class="grow">Calories by day</h2>
        <div class="chips">${S.users.map((u) => `<button class="chip ${u.id === who ? 'on' : ''}" data-who="${esc(u.id)}"><span class="dot" style="background:${esc(u.color)}"></span>${esc(u.name)}</button>`).join('')}</div>
        <div class="seg">${[7, 14, 30].map((n) => `<button data-range="${n}" class="${range === n ? 'on' : ''}">${n} days</button>`).join('')}</div></div>
      ${chart(series, days)}
      <div class="row wrap tiny muted" style="gap:14px"><span class="row"><i style="width:10px;height:10px;border-radius:3px;background:var(--herb)"></i>eaten</span><span class="row"><i style="width:10px;height:10px;border-radius:3px;background:var(--amber)"></i>eaten, over goal</span><span class="row"><i style="width:10px;height:10px;border-radius:3px;background:color-mix(in srgb,var(--herb) 30%,transparent)"></i>planned today</span></div>
    </div>

    <h2 class="section-title">Household</h2>
    <div class="card">${S.users.map((u) => `<div class="shop-item">${avatar(u)}<div class="grow"><div class="t">${esc(u.name)}${u.id === S.me.id ? ' <span class="muted small">(you)</span>' : ''}</div><div class="s">${u.isAdmin ? 'Admin' : 'Member'}</div></div>
      ${S.me.isAdmin && u.id !== S.me.id ? `<button class="btn sm ghost" data-reset="${esc(u.id)}">Reset PIN</button><button class="btn sm ghost danger" data-remove="${esc(u.id)}">Remove</button>` : ''}</div>`).join('')}</div>
    ${S.me.isAdmin ? `<button class="btn" data-addperson style="margin-top:10px">${icon('plus')}Add someone</button>` : ''}

    <h2 class="section-title">Settings</h2>
    <div class="card pad">
      <div class="row wrap" style="margin-bottom:12px"><span class="grow"><b>Week starts on</b></span><div class="seg"><button data-wk="0" class="${S.weekStartsMonday ? '' : 'on'}">Sunday</button><button data-wk="1" class="${S.weekStartsMonday ? 'on' : ''}">Monday</button></div></div>
      <div class="row wrap" style="margin-bottom:12px"><span class="grow"><b>Theme</b></span><div class="seg">${[['auto', 'Auto'], ['light', 'Light'], ['dark', 'Dark']].map(([k, l]) => `<button data-theme="${k}" class="${(localStorage.getItem('fc_theme') || 'auto') === k ? 'on' : ''}">${l}</button>`).join('')}</div></div>
      <div class="row wrap"><button class="btn" data-pin>Change my PIN</button><span class="spacer"></span><button class="btn ghost danger" data-out>Sign out</button></div>
    </div>
    <div class="note" style="margin-top:14px"><b>About Alexa:</b> Amazon doesn't let other apps add to the Alexa shopping list anymore. Use <b>Share</b> on the shopping list to send it to Notes, Reminders, a text, or any list app.</div>
    <p class="tiny muted" style="margin-top:14px">Calorie numbers are estimates from typical nutrition data - they're for planning, not medical advice.</p>`;

  $$('[data-who]', mount).forEach((b) => (b.onclick = () => { who = b.dataset.who; render(); }));
  $$('[data-range]', mount).forEach((b) => (b.onclick = () => { range = Number(b.dataset.range); render(); }));
  $$('[data-goals]', mount).forEach((b) => (b.onclick = () => goalsSheet(S.users.find((u) => u.id === b.dataset.goals))));
  $$('[data-wk]', mount).forEach((b) => (b.onclick = () => { S.weekStartsMonday = b.dataset.wk === '1'; lsSet('fc_week_mon', S.weekStartsMonday ? '1' : null); render(); }));
  $$('[data-theme]', mount).forEach((b) => (b.onclick = () => { lsSet('fc_theme', b.dataset.theme === 'auto' ? null : b.dataset.theme); applyTheme(); render(); }));
  $('[data-pin]', mount).onclick = pinSheet;
  $('[data-out]', mount).onclick = signOut;
  const add = $('[data-addperson]', mount);
  if (add) add.onclick = addPersonSheet;
  $$('[data-reset]', mount).forEach((b) => (b.onclick = () => resetPinSheet(S.users.find((u) => u.id === b.dataset.reset))));
  $$('[data-remove]', mount).forEach((b) => (b.onclick = async () => {
    const u = S.users.find((x) => x.id === b.dataset.remove);
    if (!(await confirmSheet(`Remove ${u.name}?`, `${u.name} can't sign in anymore and is taken off every planned meal. Recipes and foods stay.`, 'Remove', true))) return;
    try { await api('DELETE', `/api/users/${u.id}`); toast(`${u.name} removed.`); render(); } catch (e) { fail(e); }
  }));
}

function goalsSheet(u) {
  const g = u.goals || {};
  const sh = openSheet({
    title: `${u.name}'s daily goals`,
    body: `<p class="muted small" style="margin-top:0">Leave any blank for no goal. These are your own numbers - the app just shows how each day compares.</p>
      <label class="field"><span>Calories</span><input class="input" id="k" type="number" min="0" max="10000" value="${g.kcal ?? ''}" placeholder="e.g. 2000"></label>
      <div class="grid3"><label class="field"><span>Protein g</span><input class="input" id="p" type="number" min="0" value="${g.protein ?? ''}"></label>
      <label class="field"><span>Carbs g</span><input class="input" id="c" type="number" min="0" value="${g.carbs ?? ''}"></label>
      <label class="field"><span>Fat g</span><input class="input" id="f" type="number" min="0" value="${g.fat ?? ''}"></label></div><div class="err" id="gerr"></div>`,
    foot: '<button class="btn primary" data-save>Save goals</button>',
  });
  $('[data-save]', sh.el).onclick = async () => {
    const v = (id) => ($(id, sh.el).value === '' ? null : Number($(id, sh.el).value));
    try {
      await api('PUT', `/api/users/${u.id}`, { goals: { kcal: v('#k'), protein: v('#p'), carbs: v('#c'), fat: v('#f') } });
      sh.close();
      toast('Goals saved.');
      render();
    } catch (e) { $('#gerr', sh.el).textContent = e.message; }
  };
}

function pinSheet() {
  const sh = openSheet({
    title: 'Change my PIN',
    body: `<label class="field"><span>Current PIN</span><input class="input pin" id="c" type="password" inputmode="numeric"></label>
      <div class="grid2"><label class="field"><span>New PIN</span><input class="input pin" id="n1" type="password" inputmode="numeric"></label><label class="field"><span>Again</span><input class="input pin" id="n2" type="password" inputmode="numeric"></label></div><div class="err" id="perr"></div>`,
    foot: '<button class="btn primary" data-save>Change PIN</button>',
  });
  $('[data-save]', sh.el).onclick = async () => {
    if ($('#n1', sh.el).value !== $('#n2', sh.el).value) { $('#perr', sh.el).textContent = "The new PINs don't match."; return; }
    try { await api('PUT', '/api/me', { current_pin: $('#c', sh.el).value, new_pin: $('#n1', sh.el).value }); sh.close(); toast('PIN changed.'); } catch (e) { $('#perr', sh.el).textContent = e.message; }
  };
}

function addPersonSheet() {
  const sh = openSheet({
    title: 'Add someone',
    body: `<label class="field"><span>Name</span><input class="input" id="n" maxlength="40"></label>
      <label class="field"><span>Temporary PIN (4–8 digits) - tell them; they pick their own when they first sign in</span><input class="input pin" id="p" inputmode="numeric" maxlength="8"></label>
      <label class="field"><span>Their daily calorie goal (optional)</span><input class="input" id="k" type="number" min="0" max="10000"></label><div class="err" id="aerr"></div>`,
    foot: '<button class="btn primary" data-save>Add</button>',
  });
  $('#p', sh.el).value = String(Math.floor(1000 + Math.random() * 9000));
  $('[data-save]', sh.el).onclick = async () => {
    try {
      const k = $('#k', sh.el).value;
      const u = await api('POST', '/api/users', { name: $('#n', sh.el).value, pin: $('#p', sh.el).value, goals: { kcal: k === '' ? null : Number(k) } });
      sh.close();
      toast(`${u.name} added - give them the temporary PIN.`);
      render();
    } catch (e) { $('#aerr', sh.el).textContent = e.message; }
  };
}

function resetPinSheet(u) {
  const sh = openSheet({
    title: `New temporary PIN for ${u.name}`,
    body: `<label class="field"><span>Temporary PIN - they'll pick their own at the next sign-in</span><input class="input pin" id="p" inputmode="numeric" maxlength="8"></label><div class="err" id="rerr"></div>`,
    foot: '<button class="btn primary" data-save>Set PIN</button>',
  });
  $('#p', sh.el).value = String(Math.floor(1000 + Math.random() * 9000));
  $('[data-save]', sh.el).onclick = async () => {
    try { await api('PUT', `/api/users/${u.id}`, { new_pin: $('#p', sh.el).value }); sh.close(); toast(`Done - give ${u.name} the new PIN.`); } catch (e) { $('#rerr', sh.el).textContent = e.message; }
  };
}
