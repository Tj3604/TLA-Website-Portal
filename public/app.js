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
  const CENTER_DOC_TYPES = ['Progress report', 'Incident report', 'Form to fill out', 'Newsletter', 'Handbook', 'Other'];
  const KIND_LABEL = { announcement: 'Announcement', event: 'Event', request: 'Document request' };
  const CHILD_FIELDS = ['first_name', 'last_name', 'date_of_birth', 'classroom', 'medical_notes', 'doctor_name', 'doctor_phone',
    'emergency_contact_1', 'emergency_contact_2', 'authorized_pickups', 'photo_consent'];

  const $app = document.getElementById('app');
  const $user = document.getElementById('header-user');
  const $toast = document.getElementById('toast');

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
    if (/messages_event_needs_date/i.test(m)) return 'Events need a date.';
    if (/messages_request_one_family/i.test(m)) return 'Document requests go to one family. Choose a family.';
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
  function familyLabel(p) { return (p && (p.full_name || p.email)) || 'Unknown family'; }
  function byName(a, b) { return familyLabel(a).localeCompare(familyLabel(b)); }

  function parseDay(d) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
    return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
  }
  function formatDate(d) {
    if (!d) return '';
    const date = parseDay(d) || new Date(d);
    if (isNaN(date)) return '';
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function formatEventDate(d) {
    const date = parseDay(d);
    if (!date) return '';
    return date.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
  }
  function dayString(date) {
    return date.getFullYear() + '-' + String(date.getMonth() + 1).padStart(2, '0') + '-' + String(date.getDate()).padStart(2, '0');
  }
  function todayStr() { return dayString(new Date()); }
  function isNew(ts) { const t = Date.parse(ts); return !isNaN(t) && Date.now() - t < 7 * 24 * 3600 * 1000; }
  function age(dob) {
    const b = parseDay(dob);
    if (!b) return '';
    const now = new Date();
    let months = (now.getFullYear() - b.getFullYear()) * 12 + (now.getMonth() - b.getMonth());
    if (now.getDate() < b.getDate()) months -= 1;
    if (months < 0) return '';
    if (months < 24) return months + (months === 1 ? ' month' : ' months') + ' old';
    return Math.floor(months / 12) + ' years old';
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
  function checkFile(f) {
    if (!f) return null;
    if (f.size > MAX_FILE_BYTES) return 'That file is too big. The limit is 10 MB.';
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    if (ACCEPT.split(',').indexOf('.' + ext) === -1) return 'That file type isn’t allowed. Please use a PDF, photo, or Word document.';
    return null;
  }
  function isAdmin() { return state.profile && state.profile.role === 'admin' && state.profile.approved; }

  // ---------------- data layer: Supabase ----------------

  function makeSupabaseApi() {
    const sb = window.supabase.createClient(CFG.SUPABASE_URL, CFG.SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' }
    });
    function must(res) { if (res.error) throw res.error; return res.data; }
    const redirect = location.origin + location.pathname;
    async function upload(path, file) {
      must(await sb.storage.from('documents').upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false }));
    }
    async function openPath(path, win) {
      const data = must(await sb.storage.from('documents').createSignedUrl(path, 60));
      if (win) win.location.href = data.signedUrl; else window.location.href = data.signedUrl;
    }

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
      listDocumentsForChildren: async function (childIds) {
        if (!childIds.length) return [];
        return must(await sb.from('documents').select('*').in('child_id', childIds).order('created_at', { ascending: false }));
      },
      uploadDocument: async function (childId, file, title, docType) {
        const path = childId + '/' + uuid() + '-' + safeName(file.name);
        await upload(path, file);
        // uploaded_by and source are overwritten by the database; sent here only to satisfy its checks.
        return must(await sb.from('documents').insert({
          child_id: childId, title: title, doc_type: docType || null, storage_path: path,
          uploaded_by: state.profile.id, source: isAdmin() ? 'center' : 'parent'
        }).select().single());
      },
      openDocument: async function (doc, win) { await openPath(doc.storage_path, win); },
      listProfiles: async function () {
        return must(await sb.from('profiles').select('*').order('created_at', { ascending: false }));
      },
      setApproved: async function (id, approved) {
        must(await sb.from('profiles').update({ approved: approved }).eq('id', id));
      },

      listMessages: async function () {
        return must(await sb.from('messages')
          .select('*, family:profiles(full_name,email), child:children(first_name,last_name)')
          .order('created_at', { ascending: false }).limit(500));
      },
      createMessage: async function (m, file) {
        const id = uuid();
        const row = {
          id: id, kind: m.kind, title: m.title, body: m.body || null, audience: m.audience,
          family_id: m.family_id || null, child_id: m.child_id || null,
          event_date: m.event_date || null, event_time: m.event_time || null
        };
        if (file) {
          row.attachment_path = 'messages/' + id + '/' + uuid() + '-' + safeName(file.name);
          row.attachment_name = file.name.slice(0, 200);
          await upload(row.attachment_path, file);
        }
        return must(await sb.from('messages').insert(row).select().single());
      },
      setMessageStatus: async function (id, status) {
        must(await sb.from('messages').update({ status: status }).eq('id', id));
      },
      deleteMessage: async function (m) {
        must(await sb.from('messages').delete().eq('id', m.id));
        if (m.attachment_path) await sb.storage.from('documents').remove([m.attachment_path]);
      },
      openAttachment: async function (m, win) { await openPath(m.attachment_path, win); }
    };
  }

  // ---------------- data layer: demo (in memory) ----------------

  function makeDemoApi() {
    const S = 'demo-staff', S2 = 'demo-tina';
    const P1 = 'demo-p1', P2 = 'demo-p2', P3 = 'demo-p3', P4 = 'demo-p4', P5 = 'demo-p5', P6 = 'demo-p6', P7 = 'demo-p7', P8 = 'demo-p8';
    function daysAgo(n) { return new Date(Date.now() - n * 24 * 3600 * 1000).toISOString(); }
    function inDays(n) { const d = new Date(); d.setDate(d.getDate() + n); return dayString(d); }
    function kid(id, parent, first, last, dob, room, extra) {
      return Object.assign({ id: id, parent_id: parent, first_name: first, last_name: last, date_of_birth: dob, classroom: room,
        medical_notes: '', doctor_name: '', doctor_phone: '', emergency_contact_1: '', emergency_contact_2: '',
        authorized_pickups: '', photo_consent: true }, extra || {});
    }
    const db = {
      profiles: [
        { id: S, email: 'grace@example.com', full_name: 'Grace', role: 'admin', approved: true, created_at: '2026-09-01T12:00:00Z' },
        { id: S2, email: 'tina@example.com', full_name: 'Tina', role: 'admin', approved: true, created_at: '2026-09-01T12:00:00Z' },
        { id: P1, email: 'jessica.rivera@example.com', full_name: 'Jessica Rivera', role: 'parent', approved: true, created_at: '2026-09-03T12:00:00Z' },
        { id: P2, email: 'ashley.chen@example.com', full_name: 'Ashley Chen', role: 'parent', approved: true, created_at: '2026-09-10T12:00:00Z' },
        { id: P3, email: 'marcus.johnson@example.com', full_name: 'Marcus Johnson', role: 'parent', approved: true, created_at: '2026-09-04T12:00:00Z' },
        { id: P4, email: 'priya.shah@example.com', full_name: 'Priya Shah', role: 'parent', approved: true, created_at: '2026-09-06T12:00:00Z' },
        { id: P5, email: 'sarah.oconnell@example.com', full_name: 'Sarah O’Connell', role: 'parent', approved: true, created_at: '2026-09-08T12:00:00Z' },
        { id: P6, email: 'tom.nguyen@example.com', full_name: 'Tom Nguyen', role: 'parent', approved: true, created_at: '2026-09-12T12:00:00Z' },
        { id: P8, email: 'maria.santos@example.com', full_name: 'Maria Santos', role: 'parent', approved: true, created_at: '2026-10-02T12:00:00Z' },
        { id: P7, email: 'daniel.brooks@example.com', full_name: 'Daniel Brooks', role: 'parent', approved: false, created_at: daysAgo(2) }
      ],
      children: [
        kid('c-mia', P1, 'Mia', 'Rivera', '2022-04-18', 'Preschool', { medical_notes: 'Peanut allergy (EpiPen in cubby).', doctor_name: 'Dr. Patel',
          doctor_phone: '(508) 555-0142', emergency_contact_1: 'Carlos Rivera (dad) · (508) 555-0191', emergency_contact_2: 'Maria Lopez (grandma) · (508) 555-0177',
          authorized_pickups: 'Carlos Rivera, Maria Lopez' }),
        kid('c-leo', P1, 'Leo', 'Rivera', '2024-08-02', 'Toddlers', { doctor_name: 'Dr. Patel', doctor_phone: '(508) 555-0142',
          emergency_contact_1: 'Carlos Rivera (dad) · (508) 555-0191', authorized_pickups: 'Carlos Rivera' }),
        kid('c-noah', P2, 'Noah', 'Chen', '2025-06-21', null, { medical_notes: 'Lactose sensitive.', photo_consent: false }),
        kid('c-ava', P3, 'Ava', 'Johnson', '2021-09-14', 'Pre-K'),
        kid('c-eli', P3, 'Eli', 'Johnson', '2026-03-02', 'Infants'),
        kid('c-arjun', P4, 'Arjun', 'Shah', '2022-11-30', 'Preschool'),
        kid('c-liam', P5, 'Liam', 'O’Connell', '2024-02-11', 'Toddlers'),
        kid('c-nora', P5, 'Nora', 'O’Connell', '2021-07-19', 'Pre-K'),
        kid('c-zoe', P6, 'Zoe', 'Nguyen', '2025-12-05', 'Infants'),
        kid('c-max', P6, 'Max', 'Nguyen', '2022-06-08', 'Preschool'),
        kid('c-sofia', P8, 'Sofia', 'Santos', '2021-10-01', 'Pre-K'),
        kid('c-ben', P8, 'Ben', 'Santos', '2024-05-27', 'Toddlers')
      ],
      documents: [
        { id: 'd1', child_id: 'c-mia', source: 'center', title: 'Fall progress report', doc_type: 'Progress report', storage_path: 'c-mia/a.pdf', created_at: daysAgo(9) },
        { id: 'd2', child_id: 'c-mia', source: 'parent', title: 'Immunization record 2026', doc_type: 'Immunization record', storage_path: 'c-mia/b.pdf', created_at: '2026-09-04T10:00:00Z' },
        { id: 'd3', child_id: 'c-leo', source: 'parent', title: 'Physical exam', doc_type: 'Physical exam', storage_path: 'c-leo/c.pdf', created_at: daysAgo(4) },
        { id: 'd4', child_id: 'c-leo', source: 'center', title: 'Bumped knee on playground', doc_type: 'Incident report', storage_path: 'c-leo/d.pdf', created_at: daysAgo(25) },
        { id: 'd5', child_id: 'c-ava', source: 'parent', title: 'Enrollment form', doc_type: 'Enrollment form', storage_path: 'c-ava/e.pdf', created_at: daysAgo(40) }
      ],
      messages: [
        { id: 'm1', kind: 'announcement', title: 'November newsletter', body: 'Our November newsletter is attached: what each classroom is learning, staff birthdays, and winter clothing reminders.',
          audience: 'all', family_id: null, child_id: null, event_date: null, event_time: null,
          attachment_path: 'messages/m1/newsletter.pdf', attachment_name: 'November newsletter.pdf', status: 'open', created_at: daysAgo(3) },
        { id: 'm2', kind: 'event', title: 'Thanksgiving feast', body: 'Families are welcome to join us for lunch. Please let your child’s teacher know if you’re coming.',
          audience: 'all', family_id: null, child_id: null, event_date: inDays(8), event_time: '11:30 AM',
          attachment_path: null, attachment_name: null, status: 'open', created_at: daysAgo(5) },
        { id: 'm3', kind: 'event', title: 'Fall picture day', body: 'Photographer visits all classrooms.', audience: 'all', family_id: null, child_id: null,
          event_date: inDays(-12), event_time: '9:00 AM', attachment_path: null, attachment_name: null, status: 'open', created_at: daysAgo(30) },
        { id: 'm4', kind: 'request', title: 'Updated immunization record', body: 'Mia’s record on file expires this month. Please upload the latest copy from Dr. Patel.',
          audience: 'family', family_id: P1, child_id: 'c-mia', event_date: null, event_time: null,
          attachment_path: null, attachment_name: null, status: 'open', created_at: daysAgo(2) },
        { id: 'm5', kind: 'request', title: 'Signed 2027 enrollment agreement', body: 'Please sign the attached agreement and upload it here by December 1.',
          audience: 'family', family_id: P1, child_id: null, event_date: null, event_time: null,
          attachment_path: 'messages/m5/agreement.pdf', attachment_name: 'Enrollment agreement 2027.pdf', status: 'open', created_at: daysAgo(6) },
        { id: 'm6', kind: 'request', title: 'Physical exam form', body: 'Thank you!', audience: 'family', family_id: P1, child_id: 'c-leo',
          event_date: null, event_time: null, attachment_path: null, attachment_name: null, status: 'done', created_at: daysAgo(14) },
        { id: 'm7', kind: 'announcement', title: 'Closed for Thanksgiving', body: 'The center is closed Thursday and Friday of Thanksgiving week. We reopen Monday at 6:30 AM.',
          audience: 'all', family_id: null, child_id: null, event_date: null, event_time: null,
          attachment_path: null, attachment_name: null, status: 'open', created_at: daysAgo(10) },
        { id: 'm8', kind: 'request', title: 'Allergy action plan', body: 'Please upload Noah’s plan from his doctor.', audience: 'family', family_id: P2, child_id: 'c-noah',
          event_date: null, event_time: null, attachment_path: null, attachment_name: null, status: 'open', created_at: daysAgo(1) },
        { id: 'm9', kind: 'announcement', title: 'Noah’s classroom', body: 'Noah will start in the Infants room on Monday.', audience: 'family', family_id: P2, child_id: 'c-noah',
          event_date: null, event_time: null, attachment_path: null, attachment_name: null, status: 'open', created_at: daysAgo(1) }
      ]
    };
    let me = P1;
    const listeners = [];
    function clone(x) { return JSON.parse(JSON.stringify(x)); }
    function prof(id) { return db.profiles.find(function (p) { return p.id === id; }); }
    function admin() { const p = prof(me); return p && p.role === 'admin'; }
    function canSeeChild(c) { return admin() || c.parent_id === me; }
    function withParent(c) { const p = prof(c.parent_id) || {}; const o = clone(c); o.parent = { full_name: p.full_name, email: p.email }; return o; }
    function canSeeMessage(m) { return admin() || m.audience === 'all' || m.family_id === me; }
    function withRefs(m) {
      const o = clone(m);
      const f = m.family_id && prof(m.family_id);
      o.family = f ? { full_name: f.full_name, email: f.email } : null;
      const c = m.child_id && db.children.find(function (x) { return x.id === m.child_id; });
      o.child = c ? { first_name: c.first_name, last_name: c.last_name } : null;
      return o;
    }
    function wait() { return new Promise(function (r) { setTimeout(r, 120); }); }
    function needAdmin() { if (!admin()) throw new Error('permission denied'); }

    return {
      demo: true,
      viewAs: function (role) { me = role === 'admin' ? S : P1; listeners.forEach(function (cb) { cb('SIGNED_IN', { user: { id: me } }); }); },
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
      listDocumentsForChildren: async function (childIds) {
        await wait();
        return clone(db.documents.filter(function (d) {
          const c = db.children.find(function (x) { return x.id === d.child_id; });
          return childIds.indexOf(d.child_id) !== -1 && c && canSeeChild(c);
        })).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
      },
      uploadDocument: async function (childId, file, title, docType) {
        await wait();
        const c = db.children.find(function (x) { return x.id === childId; });
        if (!c || !canSeeChild(c)) throw new Error('permission denied');
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
        await wait(); needAdmin();
        const p = prof(id); if (p) p.approved = approved;
      },
      listMessages: async function () {
        await wait();
        if (!prof(me).approved) return [];
        return db.messages.filter(canSeeMessage).map(withRefs).sort(function (a, b) { return b.created_at.localeCompare(a.created_at); });
      },
      createMessage: async function (m, file) {
        await wait(); needAdmin();
        if (m.kind === 'event' && !m.event_date) throw new Error('Events need a date.');
        if (m.kind === 'request' && m.audience !== 'family') throw new Error('Document requests go to one family. Choose a family.');
        if (m.child_id) {
          const c = db.children.find(function (x) { return x.id === m.child_id; });
          if (!c || c.parent_id !== m.family_id) throw new Error('That child does not belong to this family.');
        }
        const id = 'm-' + uuid().slice(0, 8);
        const row = {
          id: id, kind: m.kind, title: m.title, body: m.body || null, audience: m.audience,
          family_id: m.audience === 'family' ? m.family_id : null, child_id: m.child_id || null,
          event_date: m.event_date || null, event_time: m.event_time || null,
          attachment_path: file ? 'messages/' + id + '/' + safeName(file.name) : null, attachment_name: file ? file.name : null,
          status: 'open', created_at: new Date().toISOString()
        };
        db.messages.push(row);
        return clone(row);
      },
      setMessageStatus: async function (id, status) {
        await wait(); needAdmin();
        const m = db.messages.find(function (x) { return x.id === id; }); if (m) m.status = status;
      },
      deleteMessage: async function (m) {
        await wait(); needAdmin();
        db.messages = db.messages.filter(function (x) { return x.id !== m.id; });
      },
      openAttachment: async function (m, win) {
        if (win) win.close();
        toast('Demo mode: “' + (m.attachment_name || 'the attachment') + '” would open here in a new tab.');
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
      h('span', { class: 'who', text: isAdmin() ? name + ' (Staff)' : name }),
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
      h('span', { class: 'btn-row' }, h('span', { text: 'View as:' }), h('span', { class: 'segmented', role: 'group', 'aria-label': 'View as' }, btn('parent', 'Parent'), btn('admin', 'Staff')))
    ));
  }

  // ---------------- shared bits ----------------

  function field(labelText, input, hint) {
    const id = input.id || ('f-' + uuid().slice(0, 8));
    input.id = id;
    return h('div', { class: 'field' },
      h('label', { for: id, text: labelText }), input, hint ? h('span', { class: 'hint', text: hint }) : null);
  }

  // Open a private file: open the tab right away (so pop-up blockers allow it),
  // then point it at a link that expires in 60 seconds.
  function openButton(label, ariaLabel, opener, cls) {
    return h('button', { class: 'btn ' + (cls || 'btn-quiet'), type: 'button', 'aria-label': ariaLabel, onclick: async function (e) {
      const win = DEMO ? null : window.open('', '_blank');
      if (win) { try { win.opener = null; } catch (_) { /* ignore */ } }
      await busy(e.currentTarget, 'Opening…', async function () {
        try { await opener(win); } catch (ex) { if (win) win.close(); toast(friendlyError(ex)); }
      });
    } }, label);
  }

  // In-page "are you sure?" (no browser pop-ups).
  function confirmInline(host, question, yesLabel, onYes) {
    const keep = Array.from(host.childNodes);
    clear(host);
    const yes = h('button', { class: 'btn btn-danger-solid', type: 'button' }, yesLabel);
    const no = h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { clear(host); keep.forEach(function (n) { host.append(n); }); } }, 'Cancel');
    yes.addEventListener('click', async function () { await busy(yes, 'Working…', onYes); });
    host.append(h('span', { class: 'confirm-q', text: question }), yes, no);
    no.focus();
  }

  function stat(n, label) { return h('div', { class: 'stat' }, h('div', { class: 'num', text: String(n) }), h('div', { class: 'lbl', text: label })); }

  function tabBar(tabs, current, onPick) {
    return h('div', { class: 'tabs', role: 'tablist' }, tabs.map(function (t) {
      return h('button', { class: 'tab', role: 'tab', type: 'button', 'aria-selected': current === t[0] ? 'true' : 'false',
        onclick: function () { onPick(t[0]); } },
        t[1], t[2] ? h('span', { class: 'count', 'aria-label': t[2] + ' ' + (t[3] || 'waiting'), text: String(t[2]) }) : null);
    }));
  }

  // ---------------- auth screens ----------------

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
      h('p', { class: 'lead', text: 'One private place for your child’s information, forms, and news from the center.' }),
      h('ul', { class: 'auth-points' },
        h('li', null, check(), h('span', { text: 'Keep allergies, emergency contacts, and pickup lists up to date' })),
        h('li', null, check(), h('span', { text: 'Upload forms and open documents from the center' })),
        h('li', null, check(), h('span', { text: 'See upcoming events and the documents the center needs from you' }))),
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
      form = h('form', { onsubmit: async function (e) {
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
        h('p', { class: 'muted small', text: 'For families enrolled at ' + CENTER + '. The center approves each account before it can see anything.' }),
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
      h('p', { text: CENTER + ' needs to approve your account before you can see your child’s information. You’ll be able to log in as soon as the center approves it.' }),
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
    if (r.name === 'child') return renderChild(r.id, r.request || null);
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

  // ---------------- messages: shared pieces ----------------

  function audienceText(m) {
    if (m.audience === 'all') return 'All families';
    const fam = m.family ? familyLabel(m.family) : 'One family';
    return m.child ? fam + ' · ' + fullName(m.child) : fam;
  }
  function eventWhen(m) {
    const d = formatEventDate(m.event_date);
    if (!m.event_time) return d;
    return d + (/^\d/.test(m.event_time) ? ' at ' : ', ') + m.event_time;
  }
  function dateTile(d) {
    const date = parseDay(d);
    return h('div', { class: 'date-tile', 'aria-hidden': 'true' },
      h('span', { class: 'mon', text: date ? date.toLocaleDateString('en-US', { month: 'short' }) : '' }),
      h('span', { class: 'day', text: date ? String(date.getDate()) : '' }));
  }
  function newBadge(m) { return isNew(m.created_at) ? h('span', { class: 'badge-new', text: 'New' }) : null; }
  function attachmentButton(m) {
    if (!m.attachment_path) return null;
    return openButton('Open ' + (m.attachment_name ? 'attachment' : 'file'), 'Open ' + (m.attachment_name || 'attachment') + ' for ' + m.title,
      function (win) { return api.openAttachment(m, win); });
  }

  // ---------------- parent home ----------------

  async function renderParentHome() {
    mount(h('p', { class: 'loading', text: 'Loading your family…' }));
    let kids, msgs;
    try { const r = await Promise.all([api.listChildren(), api.listMessages()]); kids = r[0]; msgs = r[1]; }
    catch (ex) { return mount(h('p', { class: 'error', role: 'alert', text: friendlyError(ex) })); }
    const first = firstWord(state.profile.full_name) || 'there';
    const cards = kids.map(function (c, i) {
      return h('article', { class: 'child-card' },
        h('div', { class: 'band band-' + (i % 3) }),
        h('div', { class: 'body' },
          h('h3', { text: fullName(c) }),
          h('p', { class: 'muted', text: [age(c.date_of_birth), c.date_of_birth ? 'Born ' + formatDate(c.date_of_birth) : ''].filter(Boolean).join(' · ') || 'Birthday not added yet' }),
          h('p', null, c.classroom ? h('span', { class: 'chip chip-green', text: c.classroom }) : h('span', { class: 'chip chip-muted', text: 'Classroom: set by the center' })),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn btn-primary', type: 'button', onclick: function () { go({ name: 'child', id: c.id }); } }, 'Info & documents'),
            h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go({ name: 'childForm', id: c.id }); } }, 'Edit'))));
    });
    cards.push(h('button', { class: 'add-card', type: 'button', onclick: function () { go({ name: 'childForm' }); } },
      h('span', { class: 'plus', 'aria-hidden': 'true', text: '+' }), 'Add a child'));

    mount(h('div', null,
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', { text: 'Welcome back, ' + first }),
        h('p', { class: 'muted', text: 'News from ' + CENTER + ', and your child’s info and documents.' }))),
      messageBoard(msgs, kids),
      h('section', { class: 'kids-section', 'aria-labelledby': 'kids-h' },
        h('h2', { id: 'kids-h', text: kids.length === 1 ? 'Your child' : 'Your children' }),
        h('div', { class: 'grid-cards' }, cards))));
  }

  function messageBoard(msgs, kids) {
    const today = todayStr();
    const me = state.profile.id;
    const requests = msgs.filter(function (m) { return m.kind === 'request' && m.status === 'open' && m.family_id === me; });
    const events = msgs.filter(function (m) { return m.kind === 'event' && m.event_date && m.event_date >= today; })
      .sort(function (a, b) { return a.event_date.localeCompare(b.event_date) || (a.event_time || '').localeCompare(b.event_time || ''); });
    const news = msgs.filter(function (m) { return m.kind === 'announcement'; }).slice(0, 10);

    function requestItem(m) {
      const actions = h('div', { class: 'btn-row' });
      const uploadBtn = h('button', { class: 'btn btn-primary', type: 'button' }, 'Upload now');
      uploadBtn.addEventListener('click', function () {
        if (m.child_id) return go({ name: 'child', id: m.child_id, request: m.title });
        if (kids.length === 1) return go({ name: 'child', id: kids[0].id, request: m.title });
        if (kids.length === 0) { toast('Add your child first, then upload from their page.'); return go({ name: 'childForm' }); }
        clear(actions);
        append(actions, [h('span', { class: 'confirm-q', text: 'Which child is it for?' }),
          kids.map(function (c) {
            return h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go({ name: 'child', id: c.id, request: m.title }); } }, c.first_name);
          })]);
      });
      append(actions, [uploadBtn, attachmentButton(m)]);
      return h('li', { class: 'msg msg-request' },
        h('div', { class: 'msg-head' }, h('p', { class: 'msg-title', text: m.title }), newBadge(m)),
        h('p', { class: 'msg-meta', text: [m.child ? 'For ' + m.child.first_name : 'For your family', 'Asked ' + formatDate(m.created_at)].join(' · ') }),
        m.body ? h('p', { class: 'msg-body', text: m.body }) : null,
        actions);
    }
    function eventItem(m) {
      return h('li', { class: 'msg msg-event' }, dateTile(m.event_date),
        h('div', { class: 'msg-content' },
          h('div', { class: 'msg-head' }, h('p', { class: 'msg-title', text: m.title }), newBadge(m)),
          h('p', { class: 'msg-meta', text: eventWhen(m) }),
          m.body ? h('p', { class: 'msg-body', text: m.body }) : null,
          m.attachment_path ? h('div', { class: 'btn-row' }, attachmentButton(m)) : null));
    }
    function newsItem(m) {
      return h('li', { class: 'msg' },
        h('div', { class: 'msg-head' }, h('p', { class: 'msg-title', text: m.title }), newBadge(m)),
        h('p', { class: 'msg-meta', text: formatDate(m.created_at) + (m.audience === 'family' ? ' · Just for your family' : '') }),
        m.body ? h('p', { class: 'msg-body', text: m.body }) : null,
        m.attachment_path ? h('div', { class: 'btn-row' }, attachmentButton(m)) : null);
    }
    function group(id, title, items, render, emptyText, cls) {
      return h('div', { class: 'board-group' + (cls ? ' ' + cls : ''), 'aria-labelledby': id },
        h('h3', { id: id }, title, items.length && cls === 'needs' ? h('span', { class: 'count', 'aria-label': items.length + ' open', text: String(items.length) }) : null),
        items.length ? h('ul', { class: 'msg-list' }, items.map(render)) : h('p', { class: 'empty', text: emptyText }));
    }

    return h('section', { class: 'panel board', 'aria-labelledby': 'board-h' },
      h('h2', { id: 'board-h', text: 'Message board' }),
      h('div', { class: 'board-grid' },
        group('needs-h', 'Documents we need', requests, requestItem, 'Nothing needed right now. Thank you!', requests.length ? 'needs' : null),
        group('events-h', 'Upcoming events', events, eventItem, 'No upcoming events.'),
        group('news-h', 'Announcements', news, newsItem, 'No announcements yet.')));
  }

  // ---------------- child detail (parent + staff) ----------------

  async function renderChild(id, requestTitle) {
    mount(h('p', { class: 'loading', text: 'Loading…' }));
    let c, docs;
    try { const r = await Promise.all([api.getChild(id), api.listDocuments(id)]); c = r[0]; docs = r[1]; }
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
    const upload = uploadForm(c, requestTitle);

    mount(h('div', null,
      isAdmin() && c.parent_id
        ? h('button', { class: 'link-btn back', type: 'button', onclick: function () { state.familyTab = 'children'; go({ name: 'family', id: c.parent_id }); } }, '← ' + ((c.parent && c.parent.full_name) || 'Family'))
        : backLink(),
      h('div', { class: 'page-head' }, h('div', null, h('h1', { text: fullName(c) }),
        isAdmin() && c.parent ? h('p', { class: 'muted', text: 'Family: ' + (c.parent.full_name || c.parent.email) }) : null),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: function () { go({ name: 'childForm', id: c.id }); } }, 'Edit info')),
      h('div', { class: 'two-col' },
        h('section', { class: 'panel', 'aria-labelledby': 'info-h' }, h('h2', { id: 'info-h', text: 'Child info' }), info),
        h('section', { class: 'panel', 'aria-labelledby': 'docs-h' },
          h('h2', { id: 'docs-h', text: 'Documents' }),
          requestTitle ? null : docGroup('From ' + CENTER, fromCenter, isAdmin() ? 'Nothing posted for this child yet.' : 'Nothing from the center yet.'),
          requestTitle ? null : docGroup(isAdmin() ? 'Uploaded by the family' : 'Uploaded by you', fromParent, 'No uploads yet.'),
          upload,
          requestTitle ? docGroup('From ' + CENTER, fromCenter, 'Nothing from the center yet.') : null,
          requestTitle ? docGroup('Uploaded by you', fromParent, 'No uploads yet.') : null))));
    if (requestTitle) {
      upload.scrollIntoView({ block: 'center' });
      const fileInput = upload.querySelector('input[type=file]');
      if (fileInput) fileInput.focus();
    }
  }

  function backLink() {
    return h('button', { class: 'link-btn back', type: 'button', onclick: function () { go({ name: 'home' }); } }, '← Back');
  }

  function docRow(d, extraMeta, sourceChip) {
    const ext = (d.storage_path.split('.').pop() || '').slice(0, 4).toUpperCase();
    return h('li', null,
      h('div', { class: 'doc-main' },
        h('span', { class: 'doc-icon' + (d.source === 'center' ? ' center' : ''), 'aria-hidden': 'true', text: ext || 'FILE' }),
        h('div', null, h('p', { class: 'doc-title', text: d.title }),
          h('p', { class: 'doc-meta', text: [extraMeta, sourceChip ? (d.source === 'center' ? 'From the center' : 'From the family') : '', d.doc_type, formatDate(d.created_at)].filter(Boolean).join(' · ') }))),
      openButton('Open', 'Open ' + d.title, function (win) { return api.openDocument(d, win); }));
  }

  function docGroup(title, docs, emptyText) {
    return h('div', { class: 'doc-group' },
      h('h3', { text: title }),
      docs.length === 0 ? h('p', { class: 'empty', text: emptyText }) :
        h('ul', { class: 'doc-list' }, docs.map(function (d) { return docRow(d); })));
  }

  // Upload a document. For a single child (child page) or, for staff on a
  // family page, with a picker for which child.
  function uploadForm(child, requestTitle, opts) {
    opts = opts || {};
    const kids = opts.kids || null;
    const err = errorBox();
    const types = isAdmin() ? CENTER_DOC_TYPES : DOC_TYPES;
    const title = h('input', { type: 'text', maxlength: 160, required: true, value: requestTitle || '',
      placeholder: isAdmin() ? 'e.g. Fall progress report' : 'e.g. Immunization record 2026' });
    const type = h('select', { required: true }, h('option', { value: '', text: 'Choose one…' }), types.map(function (t) { return h('option', { value: t, text: t }); }));
    const file = h('input', { type: 'file', accept: ACCEPT, required: true });
    const childSel = kids ? h('select', { required: true },
      kids.length > 1 ? h('option', { value: '', text: 'Choose a child…' }) : null,
      kids.map(function (c) { return h('option', { value: c.id, text: fullName(c) }); })) : null;
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' }, isAdmin() ? 'Post to family' : 'Upload');
    if (requestTitle) {
      const match = types.find(function (t) { return requestTitle.toLowerCase().indexOf(t.toLowerCase().split('/')[0]) !== -1; });
      if (match) type.value = match;
    }
    type.addEventListener('change', function () { if (!title.value && type.value && type.value !== 'Other') title.value = type.value; });

    const form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); err.hide();
      const f = file.files && file.files[0];
      const childId = childSel ? childSel.value : child.id;
      if (childSel && !childId) return err.show('Please choose which child this is for.');
      if (!f) return err.show('Please choose a file.');
      const bad = checkFile(f); if (bad) return err.show(bad);
      if (!title.value.trim()) return err.show('Please give the document a name.');
      if (!type.value) return err.show('Please choose a document type.');
      await busy(submit, 'Uploading…', async function () {
        try {
          await api.uploadDocument(childId, f, title.value.trim(), type.value);
          toast(isAdmin() ? 'Posted. The family can see it now.' : 'Uploaded. ' + CENTER + ' can see it now.');
          if (opts.onDone) opts.onDone(); else renderChild(childId);
        } catch (ex) { err.show(ex); }
      });
    } },
      h('div', { class: 'form-grid' },
        childSel ? (function () { const fl = field('Child', childSel); fl.classList.add('full'); return fl; })() : null,
        field('Document type', type),
        field('Name', title),
        (function () { const fl = field('File', file, 'PDF, photo, or Word document. Up to 10 MB.'); fl.classList.add('full'); return fl; })()),
      err,
      h('div', { class: 'form-actions' }, submit));

    return h('div', { class: 'doc-group' + (requestTitle ? ' requested' : '') },
      h('h3', { text: isAdmin() ? (kids ? 'Post a document for this family' : 'Post a document for this child') : 'Upload a document' }),
      requestTitle ? h('p', { class: 'notice notice-ask', role: 'status', text: CENTER + ' asked for: ' + requestTitle }) : null,
      form);
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
          ? text('classroom', 'Classroom', { max: 80, hint: 'Only staff can set this.' })
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

  // ---------------- staff: compose a message ----------------

  // opts: { families, kids, familyId (fixed), kind (default), onPosted }
  function composeForm(opts) {
    const err = errorBox();
    const kind = h('select', null,
      h('option', { value: 'announcement', text: 'Announcement' }),
      h('option', { value: 'event', text: 'Event' }),
      h('option', { value: 'request', text: 'Document request' }));
    kind.value = opts.kind || 'announcement';
    const fixed = opts.familyId || null;
    const families = opts.families.slice().sort(byName);
    const to = fixed ? null : h('select', null,
      h('option', { value: '', text: 'All families' }),
      families.map(function (p) { return h('option', { value: p.id, text: familyLabel(p) }); }));
    const child = h('select');
    const title = h('input', { type: 'text', maxlength: 160, required: true });
    const body = h('textarea', { rows: 4, maxlength: 4000 });
    const evDate = h('input', { type: 'date' });
    const evTime = h('input', { type: 'text', maxlength: 40, placeholder: 'e.g. 10:00 AM' });
    const file = h('input', { type: 'file', accept: ACCEPT });
    const submit = h('button', { class: 'btn btn-primary', type: 'submit' });

    const toField = to ? field('Send to', to) : null;
    const childField = field('About which child?', child, 'Optional.');
    const dateField = field('Event date', evDate);
    const timeField = field('Time', evTime, 'Optional.');
    const toHint = h('span', { class: 'hint', text: '' });
    if (toField) toField.append(toHint);

    function familyId() { return fixed || (to && to.value) || ''; }
    function refresh() {
      const k = kind.value;
      const fid = familyId();
      submit.textContent = k === 'event' ? 'Post event' : k === 'request' ? 'Send request' : 'Post announcement';
      dateField.hidden = k !== 'event';
      timeField.hidden = k !== 'event';
      if (to) {
        to.options[0].disabled = k === 'request';
        toHint.textContent = k === 'request' ? 'Document requests go to one family.' : '';
      }
      const theirKids = opts.kids.filter(function (c) { return c.parent_id === fid; });
      const keep = child.value;
      clear(child);
      child.append(h('option', { value: '', text: 'Whole family' }));
      theirKids.forEach(function (c) { child.append(h('option', { value: c.id, text: fullName(c) })); });
      child.value = theirKids.some(function (c) { return c.id === keep; }) ? keep : '';
      childField.hidden = !fid || theirKids.length === 0;
      title.placeholder = k === 'event' ? 'e.g. Thanksgiving feast' : k === 'request' ? 'e.g. Updated immunization record' : 'e.g. Closed Friday for staff training';
    }
    kind.addEventListener('change', refresh);
    if (to) to.addEventListener('change', refresh);

    const form = h('form', { onsubmit: async function (e) {
      e.preventDefault(); err.hide();
      const k = kind.value;
      const fid = familyId();
      const f = file.files && file.files[0];
      if (k === 'request' && !fid) return err.show('Document requests go to one family. Choose a family.');
      if (!title.value.trim()) return err.show('Please add a title.');
      if (k === 'event' && !evDate.value) return err.show('Please choose the event date.');
      const bad = checkFile(f); if (bad) return err.show(bad);
      const msg = {
        kind: k, title: title.value.trim(), body: body.value.trim(),
        audience: fid ? 'family' : 'all', family_id: fid || null, child_id: fid ? (child.value || null) : null,
        event_date: k === 'event' ? evDate.value : null, event_time: k === 'event' ? (evTime.value.trim() || null) : null
      };
      await busy(submit, 'Posting…', async function () {
        try {
          await api.createMessage(msg, f || null);
          toast(k === 'request' ? 'Request sent.' : fid ? 'Posted for the family.' : 'Posted for all families.');
          opts.onPosted();
        } catch (ex) { err.show(ex); }
      });
    } },
      h('div', { class: 'form-grid' },
        field('Type', kind),
        toField,
        childField,
        (function () { const fl = field('Title', title); fl.classList.add('full'); return fl; })(),
        (function () { const fl = field('Details', body, 'Optional.'); fl.classList.add('full'); return fl; })(),
        dateField, timeField,
        (function () { const fl = field('Attach a file', file, 'Optional. PDF, photo, or Word document, up to 10 MB. Families can open it from the message.'); fl.classList.add('full'); return fl; })()),
      err,
      h('div', { class: 'form-actions' }, submit));
    refresh();
    return form;
  }

  // ---------------- staff: list of messages ----------------

  // opts: { onChange, showAudience }
  function messageList(msgs, opts) {
    const filter = h('select', { 'aria-label': 'Show' },
      h('option', { value: 'all', text: 'All messages' }),
      h('option', { value: 'announcement', text: 'Announcements' }),
      h('option', { value: 'event', text: 'Events' }),
      h('option', { value: 'request', text: 'Document requests' }),
      h('option', { value: 'open', text: 'Open requests' }));
    const search = h('input', { type: 'search', placeholder: 'Search titles or families', 'aria-label': 'Search messages' });
    const list = h('ul', { class: 'rows msg-rows' });
    const today = todayStr();

    function row(m) {
      const actions = h('div', { class: 'btn-row row-actions' });
      const chips = [h('span', { class: 'chip chip-kind-' + m.kind, text: KIND_LABEL[m.kind] })];
      if (m.kind === 'request') chips.push(h('span', { class: 'chip ' + (m.status === 'open' ? 'chip-waiting' : 'chip-green'), text: m.status === 'open' ? 'Waiting' : 'Received' }));
      if (m.kind === 'event' && m.event_date < today) chips.push(h('span', { class: 'chip chip-muted', text: 'Past' }));
      append(actions, attachmentButton(m));
      if (m.kind === 'request') {
        const done = m.status === 'open';
        actions.append(h('button', { class: 'btn ' + (done ? 'btn-secondary' : 'btn-quiet'), type: 'button', onclick: async function (e) {
          await busy(e.currentTarget, 'Saving…', async function () {
            try { await api.setMessageStatus(m.id, done ? 'done' : 'open'); toast(done ? 'Marked received.' : 'Reopened.'); opts.onChange(); }
            catch (ex) { toast(friendlyError(ex)); }
          });
        } }, done ? 'Mark received' : 'Reopen'));
      }
      actions.append(h('button', { class: 'btn btn-danger', type: 'button', onclick: function () {
        confirmInline(actions, 'Delete this message?', 'Delete', async function () {
          try { await api.deleteMessage(m); toast('Message deleted.'); opts.onChange(); }
          catch (ex) { toast(friendlyError(ex)); }
        });
      } }, 'Delete'));
      return h('li', null,
        h('div', { class: 'row-main' },
          h('div', { class: 'btn-row chips' }, chips),
          h('span', { class: 'row-title', text: m.title }),
          h('span', { class: 'muted small', text: [
            opts.showAudience === false ? (m.child ? 'For ' + fullName(m.child) : '') : audienceText(m),
            m.kind === 'event' ? eventWhen(m) : '',
            'Posted ' + formatDate(m.created_at)
          ].filter(Boolean).join(' · ') }),
          m.body ? h('p', { class: 'row-body', text: m.body }) : null),
        actions);
    }
    function draw() {
      const f = filter.value;
      const q = search.value.trim().toLowerCase();
      const shown = msgs.filter(function (m) {
        if (f === 'open' && !(m.kind === 'request' && m.status === 'open')) return false;
        if (f !== 'all' && f !== 'open' && m.kind !== f) return false;
        return !q || (m.title + ' ' + audienceText(m)).toLowerCase().indexOf(q) !== -1;
      });
      clear(list);
      if (shown.length === 0) list.append(h('li', null, h('span', { class: 'empty', text: msgs.length ? 'No messages match.' : 'No messages yet.' })));
      shown.forEach(function (m) { list.append(row(m)); });
    }
    filter.addEventListener('change', draw);
    search.addEventListener('input', draw);
    draw();
    return h('div', null, h('div', { class: 'filters' }, filter, opts.showAudience === false ? null : search), list);
  }

  // ---------------- staff dashboard ----------------

  async function renderAdminHome() {
    mount(h('p', { class: 'loading', text: 'Loading…' }));
    let profiles, kids, msgs;
    try { const r = await Promise.all([api.listProfiles(), api.listChildren(), api.listMessages()]); profiles = r[0]; kids = r[1]; msgs = r[2]; }
    catch (ex) { return mount(h('p', { class: 'error', role: 'alert', text: friendlyError(ex) })); }

    const pending = profiles.filter(function (p) { return !p.approved && p.role !== 'admin'; });
    const families = profiles.filter(function (p) { return p.approved && p.role !== 'admin'; }).sort(byName);
    const openReq = msgs.filter(function (m) { return m.kind === 'request' && m.status === 'open'; });
    const refresh = function () { renderAdminHome(); };

    let body;
    if (state.adminTab === 'approvals') {
      body = h('section', { class: 'panel' },
        h('h2', { text: 'Waiting for approval' }),
        h('p', { class: 'muted small', text: 'Only approve people you recognize as parents at ' + CENTER + '. Approved parents can add children, upload documents, and see the message board.' }),
        pending.length === 0 ? h('p', { class: 'empty', text: 'No one is waiting right now.' }) :
          h('ul', { class: 'rows' }, pending.map(function (p) {
            return h('li', null,
              h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: p.full_name || '(no name given)' }),
                h('span', { class: 'muted small', text: p.email + ' · requested ' + formatDate(p.created_at) })),
              h('button', { class: 'btn btn-primary', type: 'button', onclick: async function (e) {
                await busy(e.currentTarget, 'Approving…', async function () {
                  try { await api.setApproved(p.id, true); toast((p.full_name || p.email) + ' is approved.'); refresh(); }
                  catch (ex) { toast(friendlyError(ex)); }
                });
              } }, 'Approve'));
          })));
    } else if (state.adminTab === 'messages') {
      body = h('div', null,
        h('section', { class: 'panel', 'aria-labelledby': 'compose-h' },
          h('h2', { id: 'compose-h', text: 'Post a message' }),
          h('p', { class: 'muted small', text: 'Send an announcement or event to every family, or ask one family for a document. It shows up on their message board.' }),
          composeForm({ families: families, kids: kids, onPosted: refresh })),
        h('section', { class: 'panel', 'aria-labelledby': 'posted-h' },
          h('h2', { id: 'posted-h', text: 'Posted messages' }),
          messageList(msgs, { onChange: refresh })));
    } else if (state.adminTab === 'children') {
      body = childrenPanel(kids);
    } else {
      body = familiesPanel(families, kids, msgs, refresh);
    }

    const tabs = [
      ['approvals', 'Approvals', pending.length, 'waiting'],
      ['messages', 'Messages', openReq.length, 'open requests'],
      ['children', 'Children', 0],
      ['families', 'Families', 0]
    ];
    mount(h('div', null,
      h('div', { class: 'page-head' }, h('div', null, h('h1', { text: 'Center dashboard' }),
        h('p', { class: 'muted', text: 'Approve families, post messages and documents, and keep records current.' }))),
      h('div', { class: 'stat-row' },
        stat(pending.length, 'Waiting for approval'), stat(families.length, 'Families'), stat(kids.length, 'Children'), stat(openReq.length, 'Open document requests')),
      tabBar(tabs, state.adminTab, function (t) { state.adminTab = t; renderAdminHome(); }),
      body));
  }

  function childrenPanel(kids) {
    const search = h('input', { type: 'search', placeholder: 'Search by child or parent name', 'aria-label': 'Search children' });
    const rooms = Array.from(new Set(kids.map(function (c) { return c.classroom; }).filter(Boolean))).sort();
    const room = h('select', { 'aria-label': 'Classroom' },
      h('option', { value: '', text: 'All classrooms' }),
      rooms.map(function (r) { return h('option', { value: r, text: r }); }),
      h('option', { value: '__none', text: 'No classroom yet' }));
    const countLine = h('p', { class: 'muted small result-count' });
    const list = h('ul', { class: 'rows' });
    function draw() {
      const q = search.value.trim().toLowerCase();
      const r = room.value;
      const shown = kids.filter(function (c) {
        if (r === '__none' && c.classroom) return false;
        if (r && r !== '__none' && c.classroom !== r) return false;
        return !q || (fullName(c) + ' ' + ((c.parent && c.parent.full_name) || '')).toLowerCase().indexOf(q) !== -1;
      });
      countLine.textContent = shown.length + ' of ' + kids.length + (kids.length === 1 ? ' child' : ' children');
      clear(list);
      if (shown.length === 0) list.append(h('li', null, h('span', { class: 'empty', text: 'No children match.' })));
      shown.forEach(function (c) {
        list.append(h('li', null,
          h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: fullName(c) }),
            h('span', { class: 'muted small', text: [c.parent && c.parent.full_name, age(c.date_of_birth)].filter(Boolean).join(' · ') })),
          h('div', { class: 'btn-row' },
            c.classroom ? h('span', { class: 'chip chip-green', text: c.classroom }) : h('span', { class: 'chip chip-red', text: 'No classroom' }),
            h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { go({ name: 'child', id: c.id }); } }, 'Open'))));
      });
    }
    search.addEventListener('input', draw);
    room.addEventListener('change', draw);
    draw();
    return h('section', { class: 'panel' }, h('h2', { text: 'All children' }), h('div', { class: 'filters' }, search, room), countLine, list);
  }

  function familiesPanel(families, kids, msgs, refresh) {
    const search = h('input', { type: 'search', placeholder: 'Search by parent, email, or child', 'aria-label': 'Search families' });
    const list = h('ul', { class: 'rows' });
    function kidsOf(p) { return kids.filter(function (c) { return c.parent_id === p.id; }); }
    function draw() {
      const q = search.value.trim().toLowerCase();
      const shown = families.filter(function (p) {
        const hay = [p.full_name, p.email].concat(kidsOf(p).map(fullName)).join(' ').toLowerCase();
        return !q || hay.indexOf(q) !== -1;
      });
      clear(list);
      if (shown.length === 0) list.append(h('li', null, h('span', { class: 'empty', text: families.length ? 'No families match.' : 'No approved families yet.' })));
      shown.forEach(function (p) {
        const theirKids = kidsOf(p);
        const open = msgs.filter(function (m) { return m.family_id === p.id && m.kind === 'request' && m.status === 'open'; }).length;
        const actions = h('div', { class: 'btn-row row-actions' },
          open ? h('span', { class: 'chip chip-orange', text: open + (open === 1 ? ' open request' : ' open requests') }) : null,
          h('button', { class: 'btn btn-quiet', type: 'button', onclick: function () { state.familyTab = 'children'; go({ name: 'family', id: p.id }); } }, 'Open'));
        actions.append(h('button', { class: 'btn btn-danger', type: 'button', onclick: function () {
          confirmInline(actions, 'Remove portal access for ' + familyLabel(p) + '?', 'Remove access', async function () {
            try { await api.setApproved(p.id, false); toast('Access removed.'); refresh(); }
            catch (ex) { toast(friendlyError(ex)); }
          });
        } }, 'Remove access'));
        list.append(h('li', null,
          h('div', { class: 'row-main' }, h('span', { class: 'row-title', text: familyLabel(p) }),
            h('span', { class: 'muted small', text: [p.email, theirKids.length ? theirKids.map(function (c) { return c.first_name; }).join(', ') : 'No children added yet'].join(' · ') })),
          actions));
      });
    }
    search.addEventListener('input', draw);
    draw();
    return h('section', { class: 'panel' },
      h('h2', { text: 'Families' }),
      h('p', { class: 'muted small', text: 'Open a family to see their children, documents, and messages. Removing access keeps their records but stops them from logging in.' }),
      h('div', { class: 'filters' }, search), list);
  }

  // ---------------- staff: one family ----------------

  async function renderFamily(id) {
    mount(h('p', { class: 'loading', text: 'Loading…' }));
    let profiles, kids, msgs;
    try { const r = await Promise.all([api.listProfiles(), api.listChildren(), api.listMessages()]); profiles = r[0]; kids = r[1]; msgs = r[2]; }
    catch (ex) { return mount(h('div', null, backLink(), h('p', { class: 'error', role: 'alert', text: friendlyError(ex) }))); }
    const fam = profiles.find(function (p) { return p.id === id; });
    if (!fam) return mount(h('div', null, backLink(), h('p', { class: 'error', role: 'alert', text: 'That family wasn’t found.' })));
    const theirKids = kids.filter(function (c) { return c.parent_id === fam.id; });
    const theirMsgs = msgs.filter(function (m) { return m.family_id === fam.id; });
    const openReq = theirMsgs.filter(function (m) { return m.kind === 'request' && m.status === 'open'; }).length;
    const refresh = function () { renderFamily(id); };

    let body;
    if (state.familyTab === 'documents') {
      body = h('section', { class: 'panel' }, h('h2', { text: 'Documents' }), h('p', { class: 'loading', text: 'Loading documents…' }));
      api.listDocumentsForChildren(theirKids.map(function (c) { return c.id; })).then(function (docs) {
        clear(body);
        const names = {}; theirKids.forEach(function (c) { names[c.id] = c.first_name; });
        append(body, [h('h2', { text: 'Documents' }),
          theirKids.length === 0 ? h('p', { class: 'empty', text: 'Documents are filed under a child. This family hasn’t added a child yet.' }) : null,
          theirKids.length ? h('div', { class: 'doc-group' },
            h('h3', { text: 'All documents' }),
            docs.length ? h('ul', { class: 'doc-list' }, docs.map(function (d) { return docRow(d, names[d.child_id], true); }))
              : h('p', { class: 'empty', text: 'No documents yet.' })) : null,
          theirKids.length ? uploadForm(null, null, { kids: theirKids, onDone: refresh }) : null]);
      }).catch(function (ex) { clear(body); body.append(h('p', { class: 'error', role: 'alert', text: friendlyError(ex) })); });
    } else if (state.familyTab === 'messages') {
      body = h('div', null,
        h('section', { class: 'panel', 'aria-labelledby': 'fcompose-h' },
          h('h2', { id: 'fcompose-h', text: 'Message this family' }),
          h('p', { class: 'muted small', text: 'Only ' + familyLabel(fam) + ' will see this. Use a document request to ask for a form; it shows under “Documents we need” until you mark it received.' }),
          composeForm({ families: [fam], kids: kids, familyId: fam.id, kind: 'request', onPosted: refresh })),
        h('section', { class: 'panel' },
          h('h2', { text: 'Sent to this family' }),
          h('p', { class: 'muted small', text: 'Messages for all families are on the dashboard’s Messages tab.' }),
          messageList(theirMsgs, { onChange: refresh, showAudience: false })));
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

    const tabs = [['children', 'Children', 0], ['documents', 'Documents', 0], ['messages', 'Messages', openReq, 'open requests']];
    mount(h('div', null,
      h('button', { class: 'link-btn back', type: 'button', onclick: function () { state.adminTab = 'families'; go({ name: 'home' }); } }, '← All families'),
      h('div', { class: 'page-head' }, h('div', null,
        h('h1', { text: familyLabel(fam) }),
        h('p', { class: 'muted', text: [fam.email, theirKids.length + (theirKids.length === 1 ? ' child' : ' children'), fam.approved ? 'Family since ' + formatDate(fam.created_at) : 'Access removed'].filter(Boolean).join(' · ') })),
        h('button', { class: 'btn btn-secondary', type: 'button', onclick: async function () {
          state.familyTab = 'messages'; await renderFamily(id);
          const t = document.querySelector('#fcompose-h + p + form input[type=text]');
          if (t) { t.scrollIntoView({ block: 'center' }); t.focus(); }
        } }, 'Request a document')),
      tabBar(tabs, state.familyTab, function (t) { state.familyTab = t; renderFamily(id); }),
      body));
  }

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
