/* Tina's Little Angels: Parent Portal
 * Plain JavaScript, no build step. Talks to Supabase (login, database, private files).
 * All privacy rules are enforced by the database (see schema.sql); this page only
 * shows what the database allows the logged-in person to see.
 * User-entered text is always inserted with textContent, never as HTML.
 */
(function () {
  'use strict';

  const CFG = window.PORTAL_CONFIG || {};
  const DEMO = !CFG.SUPABASE_URL || CFG.SUPABASE_URL.indexOf('YOUR-PROJECT') !== -1 || !CFG.SUPABASE_ANON_KEY || CFG.SUPABASE_ANON_KEY.indexOf('YOUR-') === 0;
  const CENTER = CFG.CENTER_NAME || "Tina's Little Angels";
  const MAX_FILE_BYTES = 10 * 1024 * 1024;
  const ACCEPT = '.pdf,.jpg,.jpeg,.png,.heic,.heif,.doc,.docx';
  const DOC_TYPES = ['Immunization record', 'Physical exam', 'Enrollment form', 'Allergy/medical plan', 'Other'];
  const CENTER_DOC_TYPES = ['Progress report', 'Incident report', 'Invoice/receipt', 'Newsletter', 'Other'];
  const CHILD_FIELDS = ['first_name', 'last_name', 'date_of_birth', 'classroom', 'medical_notes', 'doctor_name', 'doctor_phone',
    'emergency_contact_1', 'emergency_contact_2', 'authorized_pickups', 'photo_consent'];

  const $app = document.getElementById('app');
  const $user = document.getElementById('header-user');
  const $toast = document.getElementById('toast');
  const $main = document.getElementById('main');

  const state = {
    profile: null,   // { id, email, full_name, role, approved }
    route: { name: 'home' },
    adminTab: 'approvals',
    familyTab: 'children',
    recovering: false
  };

  // ---------------- small helpers ----------------

  function h(tag, props) {
    const el = document.createElement(tag);
    let value;
    let checked;
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'value') value = v;
        else if (k === 'checked') checked = v;
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) append(el, arguments[i]);
    if (value !== undefined) el.value = value;
    if (checked !== undefined) el.checked = !!checked;
    return el;
  }
  function append(el, kid) {
    if (kid === null || kid === undefined || kid === false) return;
    if (Array.isArray(kid)) { kid.forEach(function (k) { append(el, k); }); return; }
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
  function mount(node) { clear($app); $app.append(node); window.scrollTo(0, 0); }

  let toastTimer;
  function toast(msg) {
    $toast.textContent = msg;
    $toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { $toast.hidden = true; }, 3200);
  }

  function friendlyError(err) {
    const m = (err && (err.message || err.error_description)) || String(err || 'Something went wrong');
    if (/Invalid login credentials/i.test(m)) return 'That email and password don’t match. Try again or reset your password.';
    if (/Email not confirmed/i.test(m)) return 'Please confirm your email first. Check your inbox for the link we sent.';
    if (/row-level security|permission denied|not allowed/i.test(m)) return 'You don’t have permission to do that.';
    if (/mime type|invalid_mime/i.test(m)) return 'That file type isn’t allowed. Please upload a PDF, photo, or Word document.';
    if (/payload too large|exceeded the maximum/i.test(m)) return 'That file is too big. The limit is 10 MB.';
    return m;
  }

  function errorBox() {
    const box = h('p', { class: 'error', role: 'alert', hidden: true });
    box.show = function (err) { box.textContent = friendlyError(err); box.hidden = false; };
    box.hide = function () { box.hidden = true; };
    return box;
  }

  async function busy(btn, label, fn) {
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }

  function fullName(c) { return ((c.first_name || '') + ' ' + (c.last_name || '')).trim(); }
  function firstWord(s) { return (s || '').trim().split(/\s+/)[0] || ''; }

  function formatDate(d) {
    if (!d) return '';
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d);
    const date = m ? new Date(+m[1], +m[2] - 1, +m[3]) : new Date(d);
    if (isNaN(date)) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function age(dob) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dob || '');
    if (!m) return '';
    const b = new Date(+m[1], +m[2] - 1, +m[3]);
    const now = new Date();
    let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) months -= 1;
    if (months < 0) return '';
    if (months < 24) return months + (months === 1 ? ' month' : ' months') + ' old';
    const y = Math.floor(months / 12);
    return y + ' years old';
  }
  function safeName(name) {
    const cleaned = String(name || 'file').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+/, '');
    return (cleaned || 'file').slice(-80);
  }
  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    const b = crypto.getRandomValues(new Uint8Array(16));
    b[6] = (b[6] & 0x0f) | 0x40; b[8] = (b[8] & 0x3f) | 0x80;
    const x = Array.from(b, function (n) { return n.toString(16).padStart(2, '0'); }).join('');
    return x.slice(0, 8) + '-' + x.slice(8, 12) + '-' + x.slice(12, 16) + '-' + x.slice(16, 20) + '-' + x.slice(20);
  }
  function pickChild(c) {
    const row = {};
    CHILD_FIELDS.forEach(function (f) {
      let v = c[f];
      if (typeof v === 'string') v = v.trim();
      if (v === '' && f !== 'first_name' && f !== 'last_name') v = null;
      row[f] = v;
    });
    row.photo_consent = !!c.photo_consent;
    return row;
  }
  function isAdmin() { return state.profile && state.profile.role === 'admin' && state.profile.approved; }

  // ---------------- data layer: Supabase ----------------

  function makeSupabaseApi() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
    });
    function must(res) { if (res.error) throw res.error; return res.data; }
    const redirect = location.origin + location.pathname;

    return {
      onAuth: function (cb) { sb.auth.onAuthStateChange(function (event, session) { setTimeout(function () { cb(event, session); }, 0); }); },
      signUp: async function (name, email, password) {
        const data = must(await sb.auth.signUp({ email: email, password: password, options: { data: { full_name: name }, emailRedirectTo: redirect } }));
        return { needsConfirm: !data.session };
      },
      signIn: async function (email, password) { must(await sb.auth.signInWithPassword({ email: email, password: password })); },
      signOut: async function () { await sb.auth.signOut(); },
      resetPassword: async function (email) { must(await sb.auth.resetPasswordForEmail(email, { redirectTo: redirect })); },
      updatePassword: async function (pw) { must(await sb.auth.updateUser({ password: pw })); },
      profile: async function (uid) { return must(await sb.from('profiles').select('*').eq('id', uid).maybeSingle()); },

      listChildren: async function () {
        return must(await sb.from('children').select('*, parent:profiles(full_name,email)').order('first_name'));
      },
      getChild: async function (id) {
        return must(await sb.from('children').select('*, parent:profiles(full_name,email)').eq('id', id).single());
      },
      saveChild: async function (child) {
        const row = pickChild(child);
        if (child.id) return must(await sb.from('children').update(row).eq('id', child.id).select().single());
        row.parent_id = state.profile.id;
        return must(await sb.from('children').insert(row).select().single());
      },
      listDocuments: async function (childId) {
        return must(await sb.from('documents').select('*').eq('child_id', childId).order('created_at', { ascending: false }));
      },
      uploadDocument: async function (childId, file, title, docType) {
        const path = childId + '/' + uuid() + '-' + safeName(file.name);
        must(await sb.storage.from('documents').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false }));
        // uploaded_by and source are overwritten by the database; sent here only to satisfy its checks.
        return must(await sb.from('documents').insert({
          child_id: childId, title: title, doc_type: docType || null, storage_path: path,
          uploaded_by: state.profile.id, source: isAdmin() ? 'center' : 'parent'
        }).select().single());
      },
      openDocument: async function (doc, win) {
        const data = must(await sb.storage.from('documents').createSignedUrl(doc.storage_path, 60));
        if (win) win.location.href = data.signedUrl; else window.location.href = data.signedUrl;
      },
      listProfiles: async function () {
        return must(await sb.from('profiles').select('*').order('created_at', { ascending: false }));
      },
      setApproved: async function (id, approved) {
        must(await sb.from('profiles').update({ approved: approved }).eq('id', id));
      },
      listPayments: async function (startingAfter) {
        const res = await sb.functions.invoke('admin-payments', { body: { startingAfter: startingAfter || null } });
        if (res.error) {
          let msg = 'Couldn’t load payments right now.';
          try { const j = await res.error.context.json(); if (j && j.error) msg = j.error; } catch (e) { /* keep default */ }
          throw new Error(msg);
        }
        return res.data;
      }
    };
  }

  // ---------------- data layer: demo (in memory) ----------------

  function makeDemoApi() {
    const P1 = 'demo-parent-1', P2 = 'demo-parent-2', P3 = 'demo-parent-3', T = 'demo-tina';
    const db = {
      profiles: [
        { id: T, email: 'tina@example.com', full_name: 'Tina', role: 'admin', approved: true, created_at: '2026-09-01T12:00:00Z' },
        { id: P1, email: 'jessica.rivera@example.com', full_name: 'Jessica Rivera', role: 'parent', approved: true, created_at: '2026-09-03T12:00:00Z' },
        { id: P2, email: 'ashley.chen@example.com', full_name: 'Ashley Chen', role: 'parent', approved: true, created_at: '2026-09-10T12:00:00Z' },
        { id: P3, email: 'daniel.brooks@example.com', full_name: 'Daniel Brooks', role: 'parent', approved: false, created_at: '2026-11-10T15:20:00Z' }
      ],
      children: [
        { id: 'c-mia', parent_id: P1, first_name: 'Mia', last_name: 'Rivera', date_of_birth: '2022-04-18', classroom: 'Preschool',
          medical_notes: 'Peanut allergy (EpiPen in cubby).', doctor_name: 'Dr. Patel', doctor_phone: '(508) 555-0142',
          emergency_contact_1: 'Carlos Rivera (dad) · (508) 555-0191', emergency_contact_2: 'Maria Lopez (grandma) · (508) 555-0177',
          authorized_pickups: 'Carlos Rivera, Maria Lopez', photo_consent: true },
        { id: 'c-leo', parent_id: P1, first_name: 'Leo', last_name: 'Rivera', date_of_birth: '2024-08-02', classroom: 'Toddlers',
          medical_notes: '', doctor_name: 'Dr. Patel', doctor_phone: '(508) 555-0142',
          emergency_contact_1: 'Carlos Rivera (dad) · (508) 555-0191', emergency_contact_2: '',
          authorized_pickups: 'Carlos Rivera', photo_consent: true },
        { id: 'c-noah', parent_id: P2, first_name: 'Noah', last_name: 'Chen', date_of_birth: '2025-06-21', classroom: null,
          medical_notes: 'Lactose sensitive.', doctor_name: 'Dr. Kim', doctor_phone: '(508) 555-0110',
          emergency_contact_1: 'Kevin Chen · (508) 555-0123', emergency_contact_2: '', authorized_pickups: 'Kevin Chen', photo_consent: false }
      ],
      documents: [
        { id: 'd1', child_id: 'c-mia', source: 'center', title: 'Fall progress report', doc_type: 'Progress report', storage_path: 'c-mia/a.pdf', created_at: '2026-11-07T14:00:00Z' },
        { id: 'd2', child_id: 'c-mia', source: 'parent', title: 'Immunization record 2026', doc_type: 'Immunization record', storage_path: 'c-mia/b.pdf', created_at: '2026-09-04T10:00:00Z' },
        { id: 'd3', child_id: 'c-leo', source: 'parent', title: 'Physical exam', doc_type: 'Physical exam', storage_path: 'c-leo/c.pdf', created_at: '2026-09-05T10:00:00Z' },
        { id: 'd4', child_id: 'c-leo', source: 'center', title: 'Bumped knee on playground', doc_type: 'Incident report', storage_path: 'c-leo/d.pdf', created_at: '2026-10-22T16:30:00Z' }
      ]
    };
    let me = P1;
    const listeners = [];
    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function prof(id) { return db.profiles.find(function (p) { return p.id === id; }); }
    function admin() { const p = prof(me); return p && p.role === 'admin'; }
    function canSeeChild(c) { return admin() || c.parent_id === me; }
    function withParent(c) { const p = prof(c.parent_id) || {}; const o = clone(c); o.parent = { full_name: p.full_name, email: p.email }; return o; }
    function wait() { return new Promise(function (r) { setTimeout(r, 120); }); }

    return {
      demo: true,
      viewAs: function (role) { me = role === 'admin' ? T : P1; listeners.forEach(function (cb) { cb('SIGNED_IN', { user: { id: me } }); }); },
      currentRole: function () { return admin() ? 'admin' : 'parent'; },
      onAuth: function (cb) { listeners.push(cb); setTimeout(function () { cb('INITIAL_SESSION', { user: { id: me } }); }, 0); },
      signOut: async function () { toast('Demo mode: signing out is turned off.'); },
      profile: async function (uid) { return clone(prof(uid)); },
      listChildren: async function () {
        await wait();
        return db.children.filter(canSeeChild).map(withParent).sort(function (a, b) { return a.first_name.localeCompare(b.first_name); });
      },
      getChild: async function (id) {
        await wait();
        const c = db.children.find(function (x) { return x.id === id && canSeeChild(x); });
        if (!c) throw new Error('Not found');
        return withParent(c);
      },
      saveChild: async function (child) {
        await wait();
        const row = pickChild(child);
        if (child.id) {
          const c = db.children.find(function (x) { return x.id === child.id && canSeeChild(x); });
          if (!c) throw new Error('Not found');
          if (!admin()) row.classroom = c.classroom;
          Object.assign(c, row);
          return clone(c);
        }
        if (!admin()) row.classroom = null;
        const n = Object.assign({ id: 'c-' + uuid().slice(0, 8), parent_id: me }, row);
        db.children.push(n);
        return clone(n);
      },
      listDocuments: async function (childId) {
        await wait();
        const c = db.children.find(function (x) { return x.id === childId; });
        if (!c || !canSeeChild(c)) return [];
        return clone(db.documents.filter(function (d) { return d.child_id === childId; }))
          .sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
      },
      uploadDocument: async function (childId, file, title, docType) {
        await wait();
        const d = { id: 'd-' + uuid().slice(0, 8), child_id: childId, source: admin() ? 'center' : 'parent', title: title, doc_type: docType,
          storage_path: childId + '/' + uuid() + '-' + safeName(file.name), created_at: new Date().toISOString() };
        db.documents.push(d);
        return clone(d);
      },
      openDocument: async function (doc, win) {
        if (win) win.close();
        toast('Demo mode: “' + doc.title + '” would open here in a new tab.');
      },
      listProfiles: async function () { await wait(); return admin() ? clone(db.profiles) : clone([prof(me)]); },
      setApproved: async function (id, approved) {
        await wait();
        if (!admin()) throw new Error('permission denied');
        const p = prof(id); if (p) p.approved = approved;
      },
      listPayments: async function () {
        await wait();
        if (!admin()) throw new Error('permission denied');
        const t = function (s) { return Math.floor(Date.parse(s) / 1000); };
        return { hasMore: false, payments: [
          { id: 'py_1', created: t('2026-11-14T09:12:00Z'), amount: 32500, amountRefunded: 0, currency: 'usd', status: 'pending', email: 'ashley.chen@example.com', name: 'Ashley Chen', description: 'Weekly tuition', method: 'Bank •••• 6789', receiptUrl: null },
          { id: 'ch_2', created: t('2026-11-10T13:40:00Z'), amount: 65000, amountRefunded: 0, currency: 'usd', status: 'succeeded', email: 'jessica.rivera@example.com', name: 'Jessica Rivera', description: 'Tuition: 2 children', method: 'visa •••• 4242', receiptUrl: null },
          { id: 'ch_3', created: t('2026-11-07T08:05:00Z'), amount: 32500, amountRefunded: 0, currency: 'usd', status: 'succeeded', email: 'ashley.chen@example.com', name: 'Ashley Chen', description: 'Weekly tuition', method: 'Bank •••• 6789', receiptUrl: null },
          { id: 'ch_4', created: t('2026-11-05T17:22:00Z'), amount: 2500, amountRefunded: 0, currency: 'usd', status: 'succeeded', email: 'jessica.rivera@example.com', name: 'Jessica Rivera', description: 'Late pickup fee', method: 'visa •••• 4242', receiptUrl: null },
          { id: 'ch_5', created: t('2026-11-03T13:40:00Z'), amount: 65000, amountRefunded: 0, currency: 'usd', status: 'failed', email: 'jessica.rivera@example.com', name: 'Jessica Rivera', description: 'Tuition: 2 children', method: 'visa •••• 0341', receiptUrl: null },
          { id: 'ch_6', created: t('2026-10-31T08:05:00Z'), amount: 32500, amountRefunded: 32500, currency: 'usd', status: 'refunded', email: 'ashley.chen@example.com', name: 'Ashley Chen', description: 'Weekly tuition (charged twice)', method: 'Bank •••• 6789', receiptUrl: null },
          { id: 'ch_7', created: t('2026-09-02T10:00:00Z'), amount: 10000, amountRefunded: 0, currency: 'usd', status: 'succeeded', email: 'jessica.rivera@example.com', name: 'Jessica Rivera', description: 'Registration fee', method: 'visa •••• 4242', receiptUrl: null }
        ] };
      }
    };
  }

  const api = DEMO ? makeDemoApi() : makeSupabaseApi();

  // ---------------- chrome: header, footer, demo bar ----------------

  function renderHeader() {
    clear($user);
    if (!state.profile) return;
    const name = state.profile.full_name || state.profile.email;
    $user.append(
      h('span', { class: 'who', text: isAdmin() ? name + ' (Admin)' : name }),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: async function () { await api.signOut(); } }, 'Sign out')
    );
  }

  function renderFooter() {
    const f = document.getElementById('footer-text');
    clear(f);
    append(f, [CENTER, CFG.CENTER_PHONE ? ' · ' + CFG.CENTER_PHONE : '', ' · Secure parent portal']);
    if (CFG.CENTER_WEBSITE) {
      append(f, [' · ', h('a', { href: CFG.CENTER_WEBSITE, target: '_top' }, 'Back to website')]);
    }
  }

  function renderDemoBar() {
    const bar = document.getElementById('demo-bar');
    if (!DEMO) return;
    bar.hidden = false;
    clear(bar);
    const role = api.currentRole();
    const btn = function (r, label) {
      return h('button', { type: 'button', 'aria-pressed': role === r ? 'true' : 'false',
        onclick: function () { state.route = { name: 'home' }; api.viewAs(r); } }, label);
    };
    bar.append(h('div', { class: 'wrap' },
      h('span', { text: 'Demo — sample data, nothing is saved' }),
      h('span', { class: 'btn-row' }, h('span', { text: 'View as:' }), h('span', { class: 'segmented', role: 'group', 'aria-label': 'View as' }, btn('parent', 'Parent'), btn('admin', 'Tina')))
    ));
  }

  // ---------------- auth screens ----------------

  function field(labelText, input, hint) {
    const id = input.id || ('f-' + uuid().slice(0, 8));
    input.id = id;
    return h('div', { class: 'field' + (input.dataset.full ? ' full' : '') },
      h('label', { for: id, text: labelText }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  function check() {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 20 20'); svg.setAttribute('width', '20'); svg.setAttribute('height', '20'); svg.setAttribute('aria-hidden', 'true');
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    path.setAttribute('d', 'M4 10.5l3.5 3.5L16 6'); path.setAttribute('fill', 'none'); path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2'); path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
    svg.append(path); return svg;
  }
  function authIntro() {
    return h('div', { class: 'auth-intro' },
      h('h1', { text: 'The ' + CENTER + ' parent portal' }),
      h('p', { class: 'lead', text: 'One private place for your child’s information, forms, and tuition.' }),
      h('ul', { class: 'auth-points' },
        h('li', null, check(), h('span', { text: 'Keep allergies, emergency contacts, and pickup lists up to date' })),
        h('li', null, check(), h('span', { text: 'Upload forms and open documents from the center' })),
        h('li', null, check(), h('span', { text: 'Pay tuition and see past payments' }))),
      h('p', { class: 'auth-contact muted', text: [CFG.CENTER_ADDRESS, CFG.CENTER_PHONE].filter(Boolean).join(' · ') }));
  }
  function authLayout(panel) { return h('div', { class: 'auth-layout' }, authIntro(), h('div', { class: 'auth-card' }, panel)); }

  function renderAuth(mode, message) {
    state.profile = null;
    renderHeader();
    mode = mode || 'login';
    const err = errorBox();
    let form;

    if (mode === 'login') {
      const email = h('input', { type: 'email', autocomplete: 'email', required: true });
      const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Log in');
      form = h('form', { novalidate: false, onsubmit: async function (e) {
        e.preventDefault(); err.hide();
        await busy(submit, 'Logging in…', async function () {
          try { await api.signIn(email.value.trim(), pw.value); } catch (ex) { err.show(ex); }
        });
      } }, field('Email', email), field('Password', pw), err, submit);
      mount(authLayout(h('div', { class: 'panel' },
        h('h2', { text: 'Log in' }),
        message ? h('p', { class: 'notice', role: 'status', text: message }) : null,
        form,
        h('div', { class: 'auth-switch' },
          h('button', { class: 'link-btn', type: 'button', onclick: function () { renderAuth('forgot'); } }, 'Forgot your password?'),
          h('p', null, 'New family? ', h('button', { class: 'link-btn', type: 'button', onclick: function () { renderAuth('signup'); } }, 'Request access'))
        ))));
    } else if (mode === 'signup') {
      const name = h('input', { type: 'text', autocomplete: 'name', required: true, maxlength: 120 });
      const email = h('input', { type: 'email', autocomplete: 'email', required: true });
      const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Request access');
      form = h('form', { onsubmit: async function (e) {
        e.preventDefault(); err.hide();
        if (pw.value.length < 10) { err.show('Please use a password with at least 10 characters.'); return; }
        await busy(submit, 'Sending…', async function () {
          try {
            const r = await api.signUp(name.value.trim(), email.value.trim(), pw.value);
            renderAuth('login', r.needsConfirm
              ? 'Almost done! Check your email and click the confirmation link. Then ' + CENTER + ' will approve your account.'
              : 'Thanks! ' + CENTER + ' will approve your account soon.');
          } catch (ex) { err.show(ex); }
        });
      } }, field('Your full name', name), field('Email', email), field('Create a password', pw, 'At least 10 characters.'), err, submit);
      mount(authLayout(h('div', { class: 'panel' },
        h('h2', { text: 'Request access' }),
        h('p', { class: 'muted small', text: 'For families enrolled at ' + CENTER + '. Tina approves each account before it can see anything.' }),
        form,
        h('div', { class: 'auth-switch' }, h('p', null, 'Already have an account? ',
          h('button', { class: 'link-btn', type: 'button', onclick: function () { renderAuth('login'); } }, 'Log in'))))));
    } else if (mode === 'forgot') {
      const email = h('input', { type: 'email', autocomplete: 'email', required: true });
      const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Email me a reset link');
      form = h('form', { onsubmit: async function (e) {
        e.preventDefault(); err.hide();
        await busy(submit, 'Sending…', async function () {
          try { await api.resetPassword(email.value.trim()); renderAuth('login', 'If that email has an account, a reset link is on its way.'); }
          catch (ex) { err.show(ex); }
        });
      } }, field('Email', email), err, submit);
      mount(h('div', { class: 'auth-shell' }, h('div', { class: 'panel' },
        h('h1', { text: 'Reset your password' }), form,
        h('div', { class: 'auth-switch' }, h('button', { class: 'link-btn', type: 'button', onclick: function () { renderAuth('login'); } }, 'Back to log in')))));
    }
  }

  function renderNewPassword() {
    const err = errorBox();
    const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
    const pw2 = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 10 });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, 'Save new password');
    mount(h('div', { class: 'auth-shell' }, h('div', { class: 'panel' },
      h('h1', { text: 'Choose a new password' }),
      h('form', { onsubmit: async function (e) {
        e.preventDefault(); err.hide();
        if (pw.value.length < 10) { err.show('Please use at least 10 characters.'); return; }
        if (pw.value !== pw2.value) { err.show('The two passwords don’t match.'); return; }
        await busy(submit, 'Saving…', async function () {
          try { await api.updatePassword(pw.value); state.recovering = false; toast('Password updated.'); await loadProfileAndRoute(state.uid); }
          catch (ex) { err.show(ex); }
        });
      } }, field('New password', pw, 'At least 10 characters.'), field('Type it again', pw2), err, submit))));
  }

  function renderPending() {
    renderHeader();
    mount(h('div', { class: 'auth-shell' }, h('div', { class: 'panel' },
      h('h1', { text: 'Thanks! You’re almost in.' }),
      h('p', { text: CENTER + ' needs to approve your account before you can see your child’s information. You’ll be able to log in as soon as Tina approves it.' }),
      h('p', { class: 'muted small', text: 'Questions? Call ' + (CFG.CENTER_PHONE || 'the center') + '.' }))));
  }

  // ---------------- routing ----------------

  function go(route) { state.route = route; render(); }

  function render() {
    renderDemoBar();
    renderHeader();
    if (!state.profile) return;
    if (!state.profile.approved) return renderPending();
    const r = state.route;
    if (r.name === 'child') return renderChild(r.id);
    if (r.name === 'childForm') return renderChildForm(r.id || null);
    if (r.name === 'family' && isAdmin()) return renderFamily(r.id);
    return isAdmin() ? renderAdminHome() : renderParentHome();
  }

  async function loadProfileAndRoute(uid) {
    state.uid = uid;
    try {
      const p = await api.profile(uid);
      if (!p) {
        state.profile = null;
        mount(h('div', { class: 'auth-shell' }, h('div', { class: 'panel' },
          h('h1', { text: 'Account not set up' }),
          h('p', { text: 'Your login worked, but your portal account is missing. Please contact ' + CENTER + '.' }))));
        return;
      }
      state.profile = p;
      render();
    } catch (ex) {
      mount(h('p', { class: 'error', role: 'alert', text: 'Couldn’t load your account: ' + friendlyError(ex) }));
    }
  }

  // ---------------- parent home ----------------

  async function renderParentHome() {
    mount(h('p', { class: 'loading', text: 'Loading your family…' }));
    let kids;
    try { kids = await api.listChildren(); } catch (ex) { return mount(h('p', { class: 'error', role: 'alert', text: friendlyError(ex) })); }
    const first = firstWord(state.profile.full_name) || 'there';
    const cards = kids.map(function (c, i) {
      return h('article', { class: 'child-card' },
        h('div', { class: 'band band-' + (i % 3) }),
        h('div', { class: 'body' },
          h('h2', { text: fullName(c) }),
          h('p', { class: 'muted', text: [age(c.date_of_birth), c.date_of_birth ? 'Born ' + formatDate(c.date_of_birth) : ''].filter(Boolean).join(' · ') || 'Birthday not added yet' }),
          h('p', null, c.classroom ? h('span', { class: 'chip chip-green', text: c.classroom }) : h('span', { class: 'chip chip-muted', text: 'Classroom: set by Tina' })),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { go({ name: 'child', id: c.id }); } }, 'Info & documents'),
            h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go({ name: 'childForm', id: c.id }); } }, 'Edit'))));
    });
    cards.push(h('button', { class: 'add-card', type: 'button', onclick: function () { go({ name: 'childForm' }); } },
      h('span', { class: 'plus', 'aria-hidden': 'true', text: '+' }), 'Add a child'));

    mount(h('div', null,
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', { text: 'Welcome back, ' + first }),
        h('p', { class: 'muted', text: 'Keep your child’s info up to date and find documents from ' + CENTER + '.' }))),
      h('section', { 'aria-labelledby': 'kids-h' },
        h('h2', { id: 'kids-h', class: 'sr-only', text: 'My children' }),
        h('div', { class: 'grid-cards' }, cards)),
      renderPaymentsPanel()));
  }

  // ---------------- payments (Stripe-hosted; no card details ever touch this portal) ----------------

  function stripeUrl(u) {
    try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)stripe\.com$/.test(x.hostname) ? x : null; } catch (e) { return null; }
  }
  function renderPaymentsPanel() {
    const portal = stripeUrl(CFG.STRIPE_BILLING_PORTAL_URL || '');
    const oneTime = stripeUrl(CFG.STRIPE_PAYMENT_LINK || '');
    if (!DEMO && !portal && !oneTime) return null;
    if (portal && state.profile && state.profile.email) portal.searchParams.set('prefilled_email', state.profile.email);
    function payBtn(cls, url, label, demoMsg) {
      if (DEMO) return h('button', { class: 'btn ' + cls, type: 'button', onclick: function () { toast(demoMsg); } }, label);
      if (!url) return null;
      return h('a', { class: 'btn ' + cls, href: url.toString(), target: '_blank', rel: 'noopener noreferrer' }, label);
    }
    return h('section', { class: 'panel payments', 'aria-labelledby': 'pay-h' },
      h('h2', { id: 'pay-h', text: 'Tuition & payments' }),
      h('p', { class: 'muted', text: 'Payments are handled securely by Stripe. Your card or bank details are never stored in this portal.' }),
      h('div', { class: 'btn-row' },
        payBtn('btn-primary', portal, 'Pay tuition & view bills', 'Demo mode: this opens Stripe, where you can pay bills, set up autopay, and see past payments.'),
        payBtn('btn-quiet', oneTime, 'Make a one-time payment', 'Demo mode: this opens a Stripe checkout page where you enter the amount (registration fee, late pickup, etc.).')),
      h('p', { class: 'muted small', text: 'Use the same email you log in here with. Stripe will email you a sign-in link.' }));
  }

  // ---------------- child detail (parent + admin) ----------------

  async function renderChild(id) {
    mount(h('p', { class: 'loading', text: 'Loading…' }));
    let c, docs;
    try { c = await api.getChild(id); docs = await api.listDocuments(id); }
    catch (ex) { return mount(h('div', null, backLink(), h('p', { class: 'error', role: 'alert', text: friendlyError(ex) }))); }

    const fromCenter = docs.filter(function (d) { return d.source === 'center'; });
    const fromParent = docs.filter(function (d) { return d.source === 'parent'; });

    const infoRows = [
      ['Date of birth', c.date_of_birth ? formatDate(c.date_of_birth) + (age(c.date_of_birth) ? ' (' + age(c.date_of_birth) + ')' : '') : ''],
      ['Classroom', c.classroom || 'Not assigned yet'],
      ['Allergies & medical', c.medical_notes],
      ['Doctor', [c.doctor_name, c.doctor_phone].filter(Boolean).join(' · ')],
      ['Emergency contact 1', c.emergency_contact_1],
      ['Emergency contact 2', c.emergency_contact_2],
      ['Approved for pickup', c.authorized_pickups],
      ['Photo permission', c.photo_consent ? 'Yes' : 'No']
    ];
    if (isAdmin() && c.parent) infoRows.unshift(['Parent', [c.parent.full_name, c.parent.email].filter(Boolean).join(' · ')]);

    const info = h('dl', { class: 'info' }, infoRows.map(function (r) {
      return h('div', null, h('dt', { text: r[0] }), h('dd', { text: r[1] || '—' }));
    }));

    mount(h('div', null,
      backLink(),
      h('div', { class: 'page-head' }, h('div', null, h('h1', { text: fullName(c) }),
        isAdmin() && c.parent ? h('p', { class: 'muted', text: 'Family: ' + (c.parent.full_name || c.parent.email) }) : null),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: function () { go({ name: 'childForm', id: c.id }); } }, 'Edit info')),
      h('div', { class: 'two-col' },
        h('section', { class: 'panel', 'aria-labelledby': 'info-h' }, h('h2', { id: 'info-h', text: 'Child info' }), info),
        h('section', { class: 'panel', 'aria-labelledby': 'docs-h' },
          h('h2', { id: 'docs-h', text: 'Documents' }),
          docGroup('From ' + CENTER, fromCenter, 'center', isAdmin() ? 'Nothing posted for this family yet.' : 'Nothing from the center yet.'),
          docGroup(isAdmin() ? 'Uploaded by the family' : 'Uploaded by you', fromParent, 'parent', 'No uploads yet.'),
          uploadForm(c)))));
  }

  function backLink() {
    return h('button', { class: 'link-btn back', type: 'button', onclick: function () { go({ name: 'home' }); } }, '← Back');
  }

  function docGroup(title, docs, kind, emptyText) {
    return h('div', { class: 'doc-group' },
      h('h3', { text: title }),
      docs.length === 0 ? h('p', { class: 'empty', text: emptyText }) :
        h('ul', { class: 'doc-list' }, docs.map(function (d) {
          const ext = (d.storage_path.split('.').pop() || '').slice(0, 4).toUpperCase();
          return h('li', null,
            h('div', { class: 'doc-main' },
              h('span', { class: 'doc-icon' + (kind === 'center' ? ' center' : ''), 'aria-hidden': 'true', text: ext || 'FILE' }),
              h('div', null, h('p', { class: 'doc-title', text: d.title }),
                h('p', { class: 'doc-meta', text: [d.doc_type, formatDate(d.created_at)].filter(Boolean).join(' · ') }))),
            h('button', { class: 'btn btn-quiet', type: 'button', 'aria-label': 'Open ' + d.title, onclick: async function (e) {
              // Open the tab right away (so pop-up blockers allow it), then point it at a link that expires in 60 seconds.
              const win = DEMO ? null : window.open('', '_blank');
              if (win) { try { win.opener = null; } catch (_) { /* ignore */ } }
              await busy(e.currentTarget, 'Opening…', async function () {
                try { await api.openDocument(d, win); } catch (ex) { if (win) win.close(); toast(friendlyError(ex)); }
              });
            } }, 'Open'));
        })));
  }

  function uploadForm(child) {
    const err = errorBox();
    const types = isAdmin() ? CENTER_DOC_TYPES : DOC_TYPES;
    const title = h('input', { type: 'text', maxlength: 160, required: true, placeholder: isAdmin() ? 'e.g. Fall progress report' : 'e.g. Immunization record 2026' });
    const type = h('select', { required: true }, h('option', { value: '', text: 'Choose one…' }), types.map(function (t) { return h('option', { value: t, text: t }); }));
    const file = h('input', { type: 'file', accept: ACCEPT, required: true });
    const submit = h('button', { class: 'btn btn-green', type: 'submit' }, isAdmin() ? 'Post to family' : 'Upload');
    type.addEventListener('change', function () { if (!title.value && type.value && type.value !== 'Other') title.value = type.value; });

    const form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); err.hide();
      const f = file.files && file.files[0];
      if (!f) return err.show('Please choose a file.');
      if (f.size > MAX_FILE_BYTES) return err.show('That file is too big. The limit is 10 MB.');
      if (!title.value.trim()) return err.show('Please give the document a name.');
      if (!type.value) return err.show('Please choose a document type.');
      await busy(submit, 'Uploading…', async function () {
        try {
          await api.uploadDocument(child.id, f, title.value.trim(), type.value);
          toast(isAdmin() ? 'Posted. The family can see it now.' : 'Uploaded. ' + CENTER + ' can see it now.');
          renderChild(child.id);
        } catch (ex) { err.show(ex); }
      });
    } },
      h('div', { class: 'form-grid' },
        field('Document type', type),
        field('Name', title),
        (function () { const fl = field('File', file, 'PDF, photo, or Word document. Up to 10 MB.'); fl.classList.add('full'); return fl; })()),
      err,
      h('div', { class: 'form-actions' }, submit));

    return h('div', { class: 'doc-group' }, h('h3', { text: isAdmin() ? 'Post a document for this family' : 'Upload a document' }), form);
  }

  // ---------------- add / edit child ----------------

  async function renderChildForm(id) {
    let c = { first_name: '', last_name: '', photo_consent: false };
    if (id) {
      mount(h('p', { class: 'loading', text: 'Loading…' }));
      try { c = await api.getChild(id); } catch (ex) { return mount(h('p', { class: 'error', role: 'alert', text: friendlyError(ex) })); }
    }
    const err = errorBox();
    const inputs = {};
    function text(key, label, opts) {
      opts = opts || {};
      const el = opts.multiline
        ? h('textarea', { rows: 3, maxlength: opts.max || 1000, value: c[key] || '' })
        : h('input', { type: opts.type || 'text', maxlength: opts.max || 200, value: c[key] || '', readonly: opts.readonly, required: opts.required, autocomplete: 'off' });
      inputs[key] = el;
      const f = field(label, el, opts.hint);
      if (opts.full) f.classList.add('full');
      return f;
    }
    const consent = h('input', { type: 'checkbox', id: 'f-consent', checked: !!c.photo_consent });
    inputs.photo_consent = consent;

    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, id ? 'Save changes' : 'Add child');
    const form = h('form', { class: 'panel', onsubmit: async function (e) {
      e.preventDefault(); err.hide();
      const data = { id: id || undefined };
      Object.keys(inputs).forEach(function (k) { data[k] = k === 'photo_consent' ? inputs[k].checked : inputs[k].value; });
      if (!isAdmin()) data.classroom = c.classroom || null;
      if (!data.first_name.trim() || !data.last_name.trim()) return err.show('Please enter your child’s first and last name.');
      await busy(submit, 'Saving…', async function () {
        try {
          const saved = await api.saveChild(data);
          toast(id ? 'Saved.' : fullName(saved) + ' was added.');
          go({ name: 'child', id: saved.id });
        } catch (ex) { err.show(ex); }
      });
    } },
      h('div', { class: 'form-grid' },
        text('first_name', 'First name', { required: true, max: 80 }),
        text('last_name', 'Last name', { required: true, max: 80 }),
        text('date_of_birth', 'Date of birth', { type: 'date' }),
        isAdmin()
          ? text('classroom', 'Classroom', { max: 80, hint: 'Only you can set this.' })
          : text('classroom', 'Classroom', { readonly: true, hint: 'Set by ' + CENTER + '.' }),
        text('medical_notes', 'Allergies & medical notes', { multiline: true, max: 4000, full: true, hint: 'Allergies, medications, conditions the staff should know about.' }),
        text('doctor_name', 'Doctor’s name', { max: 120 }),
        text('doctor_phone', 'Doctor’s phone', { type: 'tel', max: 40 }),
        text('emergency_contact_1', 'Emergency contact 1', { hint: 'Name, relationship, phone' }),
        text('emergency_contact_2', 'Emergency contact 2', { hint: 'Name, relationship, phone' }),
        text('authorized_pickups', 'People approved to pick up', { multiline: true, max: 1000, full: true, hint: 'Full names. Staff will check ID.' }),
        h('div', { class: 'field full' }, h('label', { class: 'check', for: 'f-consent' }, consent,
          h('span', { text: 'I give permission for my child to appear in photos shared with families.' })))),
      err,
      h('div', { class: 'form-actions' }, submit,
        h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go(id ? { name: 'child', id: id } : { name: 'home' }); } }, 'Cancel')));
    if (!isAdmin() && !c.classroom) inputs.classroom.value = 'Not assigned yet';

    mount(h('div', null, backLink(),
      h('div', { class: 'page-head' }, h('h1', { text: id ? 'Edit ' + (c.first_name || 'child') + '’s info' : 'Add a child' })),
      form));
  }

  // ---------------- admin (Tina) ----------------

  async function renderAdminHome() {
    mount(h('p', { class: 'loading', text: 'Loading…' }));
    let profiles, kids;
    try { profiles = await api.listProfiles(); kids = await api.listChildren(); }
    catch (ex) { return mount(h('p', { class: 'error', role: 'alert', text: friendlyError(ex) })); }

    const pending = profiles.filter(function (p) { return !p.approved && p.role !== 'admin'; });
    const families = profiles.filter(function (p) { return p.approved && p.role !== 'admin'; });
    const tabs = [['approvals', 'Approvals', pending.length], ['children', 'Children', 0], ['families', 'Families', 0]];

    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': state.adminTab === t[0] ? 'true' : 'false',
        onclick: function () { state.adminTab = t[0]; renderAdminHome(); } },
        t[1], t[2] ? h('span', { class: 'count', 'aria-label': t[2] + ' waiting', text: String(t[2]) }) : null);
    }));

    let body;
    if (state.adminTab === 'approvals') {
      body = h('section', { class: 'panel' },
        h('h2', { text: 'Waiting for approval' }),
        h('p', { class: 'muted small', text: 'Only approve people you recognize as parents at ' + CENTER + '. Approved parents can add children and upload documents.' }),
        pending.length === 0 ? h('p', { class: 'empty', text: 'No one is waiting right now.' }) :
          h('ul', { class: 'rows' }, pending.map(function (p) {
            return h('li', null,
              h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: p.full_name || '(no name given)' }),
                h('span', { class: 'muted small', text: p.email + ' · requested ' + formatDate(p.created_at) })),
              h('button', { class: 'btn btn-green', type: 'button', onclick: async function (e) {
                await busy(e.currentTarget, 'Approving…', async function () {
                  try { await api.setApproved(p.id, true); toast((p.full_name || p.email) + ' is approved.'); renderAdminHome(); }
                  catch (ex) { toast(friendlyError(ex)); }
                });
              } }, 'Approve'));
          })));
    } else if (state.adminTab === 'children') {
      const search = h('input', { type: 'search', placeholder: 'Search by child or parent name', 'aria-label': 'Search children' });
      const list = h('ul', { class: 'rows' });
      const draw = function () {
        const q = search.value.trim().toLowerCase();
        clear(list);
        const shown = kids.filter(function (c) {
          return !q || (fullName(c) + ' ' + ((c.parent && c.parent.full_name) || '')).toLowerCase().indexOf(q) !== -1;
        });
        if (shown.length === 0) list.append(h('li', null, h('span', { class: 'empty', text: 'No children match.' })));
        shown.forEach(function (c) {
          list.append(h('li', null,
            h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: fullName(c) }),
              h('span', { class: 'muted small', text: [c.parent && c.parent.full_name, age(c.date_of_birth)].filter(Boolean).join(' · ') })),
            h('div', { class: 'btn-row' },
              c.classroom ? h('span', { class: 'chip chip-green', text: c.classroom }) : h('span', { class: 'chip chip-red', text: 'No classroom' }),
              h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go({ name: 'child', id: c.id }); } }, 'Open'))));
        });
      };
      search.addEventListener('input', draw);
      draw();
      body = h('section', { class: 'panel' }, h('h2', { text: 'All children' }), h('div', { class: 'search' }, search), list);
    } else {
      body = h('section', { class: 'panel' },
        h('h2', { text: 'Approved families' }),
        h('p', { class: 'muted small', text: 'Open a family to see their children and payments. Removing access keeps their records but stops them from logging in.' }),
        families.length === 0 ? h('p', { class: 'empty', text: 'No approved families yet.' }) :
          h('ul', { class: 'rows' }, families.map(function (p) {
            const n = kids.filter(function (c) { return c.parent_id === p.id; }).length;
            return h('li', null,
              h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: p.full_name || p.email }),
                h('span', { class: 'muted small', text: p.email + ' · ' + n + (n === 1 ? ' child' : ' children') })),
              h('div', { class: 'btn-row' },
              h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { state.familyTab = 'children'; go({ name: 'family', id: p.id }); } }, 'Open'),
              p.id === state.profile.id ? null : h('button', { class: 'btn btn-danger', type: 'button', onclick: async function (e) {
                if (!window.confirm('Remove portal access for ' + (p.full_name || p.email) + '?')) return;
                await busy(e.currentTarget, 'Removing…', async function () {
                  try { await api.setApproved(p.id, false); toast('Access removed.'); renderAdminHome(); }
                  catch (ex) { toast(friendlyError(ex)); }
                });
              } }, 'Remove access')));
          })));
    }

    const unassigned = kids.filter(function (c) { return !c.classroom; }).length;
    mount(h('div', null,
      h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Tina’s dashboard' }),
        h('p', { class: 'muted', text: 'Approve families, keep records current, and post documents.' }))),
      h('div', { class: 'stat-row' },
        stat(pending.length, 'Waiting'), stat(kids.length, 'Children'), stat(unassigned, 'Need a classroom')),
      tabBar, body));
  }
  // ---------------- Tina: one family (children + payments tabs) ----------------

  async function renderFamily(id) {
    mount(h('p', { class: 'loading', text: 'Loading…' }));
    let profiles, kids;
    try { profiles = await api.listProfiles(); kids = await api.listChildren(); }
    catch (ex) { return mount(h('div', null, backLink(), h('p', { class: 'error', role: 'alert', text: friendlyError(ex) }))); }
    const fam = profiles.find(function (p) { return p.id === id; });
    if (!fam) return mount(h('div', null, backLink(), h('p', { class: 'error', role: 'alert', text: 'That family wasn’t found.' })));
    const theirKids = kids.filter(function (c) { return c.parent_id === fam.id; });

    const tabs = [['children', 'Children'], ['payments', 'Payments']];
    const tabBar = h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': state.familyTab === t[0] ? 'true' : 'false',
        onclick: function () { state.familyTab = t[0]; renderFamily(id); } }, t[1]);
    }));

    let body;
    if (state.familyTab === 'payments') {
      body = renderPaymentsTab(profiles, (fam.email || '').toLowerCase());
    } else {
      body = h('section', { class: 'panel' },
        h('h2', { text: 'Children' }),
        theirKids.length === 0 ? h('p', { class: 'empty', text: 'This family hasn’t added a child yet.' }) :
          h('ul', { class: 'rows' }, theirKids.map(function (c) {
            return h('li', null,
              h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: fullName(c) }),
                h('span', { class: 'muted small', text: [age(c.date_of_birth), c.date_of_birth ? 'Born ' + formatDate(c.date_of_birth) : ''].filter(Boolean).join(' · ') })),
              h('div', { class: 'btn-row' },
                c.classroom ? h('span', { class: 'chip chip-green', text: c.classroom }) : h('span', { class: 'chip chip-red', text: 'No classroom' }),
                h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go({ name: 'child', id: c.id }); } }, 'Open')));
          })));
    }

    mount(h('div', null,
      h('button', { class: 'link-btn back', type: 'button', onclick: function () { state.adminTab = 'families'; go({ name: 'home' }); } }, '← All families'),
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', { text: fam.full_name || fam.email }),
        h('p', { class: 'muted', text: [fam.email, theirKids.length + (theirKids.length === 1 ? ' child' : ' children'), fam.approved ? 'Family since ' + formatDate(fam.created_at) : 'Access removed'].filter(Boolean).join(' · ') }))),
      tabBar, body));
  }

  // ---------------- Tina: payments from families (read-only, from Stripe) ----------------

  function money(cents, currency) {
    return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: (currency || 'usd').toUpperCase() });
  }
  const PAY_STATUS = {
    succeeded: ['Paid', 'chip-green'], pending: ['Processing', 'chip-muted'], failed: ['Failed', 'chip-red'],
    refunded: ['Refunded', 'chip-muted']
  };
  function renderPaymentsTab(profiles, onlyEmail) {
    const byEmail = {};
    profiles.forEach(function (p) { if (p.email) byEmail[p.email.toLowerCase()] = p; });
    const famSelect = h('select', { 'aria-label': 'Show payments for' }, h('option', { value: '', text: 'All families' }));
    const totalLine = h('p', { class: 'pay-total' });
    const list = h('ul', { class: 'rows' }, h('li', null, h('span', { class: 'muted', text: 'Loading payments from Stripe…' })));
    const moreBtn = h('button', { class: 'btn btn-quiet', type: 'button', hidden: true }, 'Load older payments');
    let all = [];

    function familyName(p) {
      const prof = p.email && byEmail[p.email];
      return (prof && (prof.full_name || prof.email)) || p.name || p.email || 'Unknown payer';
    }
    function draw() {
      const want = onlyEmail ? '' : famSelect.value;
      const shown = all.filter(function (p) {
        if (onlyEmail) return (p.email || '').toLowerCase() === onlyEmail;
        return !want || familyName(p) === want;
      });
      clear(list);
      if (shown.length === 0) list.append(h('li', null, h('span', { class: 'empty', text: 'No payments yet.' })));
      let paid = 0;
      shown.forEach(function (p) {
        if (p.status === 'succeeded') paid += p.amount - (p.amountRefunded || 0);
        const st = PAY_STATUS[p.status] || [p.status, 'chip-muted'];
        list.append(h('li', null,
          h('div', { class: 'row-main' },
            h('span', { class: 'row-title', text: (onlyEmail ? (p.description || 'Payment') : familyName(p)) + ' · ' + money(p.amount, p.currency) }),
            h('span', { class: 'muted small', text: [formatDate(new Date(p.created * 1000).toISOString()), onlyEmail ? '' : p.description, p.method].filter(Boolean).join(' · ') })),
          h('div', { class: 'btn-row' },
            h('span', { class: 'chip ' + st[1], text: st[0] }),
            p.receiptUrl ? h('a', { class: 'btn btn-quiet', href: p.receiptUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Receipt') : null)));
      });
      totalLine.textContent = onlyEmail ? 'Total paid: ' + money(paid, 'usd') : (want ? want : 'All families') + ': ' + money(paid, 'usd') + ' paid in the payments shown';
    }
    function fillFamilies() {
      const names = Array.from(new Set(all.map(familyName))).sort();
      const keep = famSelect.value;
      clear(famSelect);
      famSelect.append(h('option', { value: '', text: 'All families' }));
      names.forEach(function (n) { famSelect.append(h('option', { value: n, text: n })); });
      famSelect.value = names.indexOf(keep) !== -1 ? keep : '';
    }
    async function load(after) {
      try {
        const res = await api.listPayments(after);
        all = all.concat(res.payments || []);
        moreBtn.hidden = !res.hasMore;
        fillFamilies(); draw();
      } catch (ex) {
        clear(list);
        list.append(h('li', null, h('span', { class: 'error', role: 'alert', text: ex && ex.message ? ex.message : friendlyError(ex) })));
      }
    }
    famSelect.addEventListener('change', draw);
    moreBtn.addEventListener('click', async function (e) {
      await busy(e.currentTarget, 'Loading…', function () { return load(all.length ? all[all.length - 1].id : null); });
    });
    load(null);

    return h('section', { class: 'panel' },
      h('h2', { text: onlyEmail ? 'Payments' : 'Payments from families' }),
      h('p', { class: 'muted small', text: onlyEmail
        ? 'Pulled live from Stripe, newest first, matched by this family’s portal email (' + onlyEmail + '). To refund or change a bill, use the Stripe dashboard.'
        : 'Pulled live from Stripe, newest first. Families are matched by the email they use for the portal. To refund or change a bill, use the Stripe dashboard.' }),
      onlyEmail ? null : h('div', { class: 'pay-filter' }, famSelect),
      totalLine, list, moreBtn);
  }

  function stat(n, label) { return h('div', { class: 'stat' }, h('div', { class: 'num', text: String(n) }), h('div', { class: 'lbl', text: label })); }

  // ---------------- start ----------------

  (function brandMark() {
    const mark = document.getElementById('brand-mark');
    if (!mark || !CFG.LOGO_URL || !/^[A-Za-z0-9._\/-]+$/.test(CFG.LOGO_URL)) return;
    const img = h('img', { src: CFG.LOGO_URL, alt: '' });
    img.addEventListener('error', function () { mark.classList.remove('has-logo'); clear(mark); mark.textContent = 'T'; });
    clear(mark); mark.classList.add('has-logo'); mark.append(img);
  })();

  renderFooter();
  if (!DEMO && !(window.supabase && window.supabase.createClient)) {
    mount(h('p', { class: 'error', role: 'alert', text: 'The portal couldn’t load. Please refresh the page.' }));
    return;
  }

  api.onAuth(async function (event, session) {
    if (event === 'PASSWORD_RECOVERY') { state.recovering = true; state.uid = session && session.user && session.user.id; return renderNewPassword(); }
    if (state.recovering) return;
    if (event === 'SIGNED_OUT' || !session) { state.route = { name: 'home' }; return renderAuth('login'); }
    if (event === 'TOKEN_REFRESHED' || event === 'USER_UPDATED') return;
    if (event === 'SIGNED_IN' && state.profile && state.profile.id === session.user.id && !DEMO) return;
    await loadProfileAndRoute(session.user.id);
  });
})();
