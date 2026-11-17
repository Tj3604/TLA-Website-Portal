-- =====================================================================
-- Tina's Little Angels: Parent Portal database setup
-- Run ONCE in Supabase: SQL Editor > New query > paste all of this > Run.
--
-- What this sets up
--   profiles   one row per account (parent or admin), created automatically
--   children   child profiles; each parent sees and edits only their own
--   documents  file records; parents see only their own children's files
--   messages   the message board: announcements, events, and document
--              requests, sent to all families or to one family
--   storage    a PRIVATE bucket "documents"; files open only through
--              short-lived links, and only for the right family or an admin
--
-- New accounts start as "not approved" and can see nothing until an admin
-- approves them inside the portal.
-- =====================================================================

create extension if not exists pgcrypto;

-- ---------- Tables ----------------------------------------------------

create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text not null,
  full_name   text,
  role        text not null default 'parent' check (role in ('parent', 'admin')),
  approved    boolean not null default false,
  created_at  timestamptz not null default now()
);

create table if not exists public.children (
  id                   uuid primary key default gen_random_uuid(),
  parent_id            uuid not null references public.profiles(id) on delete cascade,
  first_name           text not null check (char_length(first_name) between 1 and 80),
  last_name            text not null check (char_length(last_name) between 1 and 80),
  date_of_birth        date,
  classroom            text check (char_length(classroom) <= 80),
  medical_notes        text check (char_length(medical_notes) <= 4000),
  doctor_name          text check (char_length(doctor_name) <= 120),
  doctor_phone         text check (char_length(doctor_phone) <= 40),
  emergency_contact_1  text check (char_length(emergency_contact_1) <= 200),
  emergency_contact_2  text check (char_length(emergency_contact_2) <= 200),
  authorized_pickups   text check (char_length(authorized_pickups) <= 1000),
  photo_consent        boolean not null default false,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create table if not exists public.documents (
  id            uuid primary key default gen_random_uuid(),
  child_id      uuid not null references public.children(id) on delete cascade,
  uploaded_by   uuid not null references public.profiles(id) on delete cascade,
  source        text not null check (source in ('parent', 'center')),
  title         text not null check (char_length(title) between 1 and 160),
  doc_type      text check (char_length(doc_type) <= 80),
  storage_path  text not null unique,
  created_at    timestamptz not null default now()
);

create index if not exists children_parent_idx on public.children(parent_id);
create index if not exists documents_child_idx  on public.documents(child_id);

-- Message board. "all" messages go to every approved family; "family"
-- messages go to one parent account (optionally about one of their children).
create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  kind             text not null check (kind in ('announcement', 'event', 'request')),
  title            text not null check (char_length(title) between 1 and 160),
  body             text check (char_length(body) <= 4000),
  audience         text not null check (audience in ('all', 'family')),
  family_id        uuid references public.profiles(id) on delete cascade,
  child_id         uuid references public.children(id) on delete cascade,
  event_date       date,
  event_time       text check (char_length(event_time) <= 40),
  attachment_path  text unique,
  attachment_name  text check (char_length(attachment_name) <= 200),
  status           text not null default 'open' check (status in ('open', 'done')),
  created_by       uuid default auth.uid(),
  created_at       timestamptz not null default now(),
  constraint messages_audience_family check (
    (audience = 'all' and family_id is null and child_id is null)
    or (audience = 'family' and family_id is not null)
  ),
  constraint messages_event_needs_date check (kind <> 'event' or event_date is not null),
  constraint messages_request_one_family check (kind <> 'request' or audience = 'family')
);

create index if not exists messages_family_idx  on public.messages(family_id);
create index if not exists messages_created_idx on public.messages(created_at desc);
create index if not exists messages_event_idx   on public.messages(event_date);

-- ---------- Helper checks (run with owner rights, read-only) -----------

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role = 'admin' and approved
  );
$$;

create or replace function public.is_approved()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and approved
  );
$$;

create or replace function public.owns_child(cid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.children
    where id = cid and parent_id = auth.uid()
  );
$$;

-- Files live in the private "documents" bucket at one of two kinds of path:
--   <child id>/<random>-<file name>          a child's document
--   messages/<message id>/<random>-<name>    a message-board attachment
-- Read: admin; the approved parent who owns that child; or, for message
-- attachments, an approved parent who can see that message.
create or replace function public.can_read_path(p text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  cid uuid;
  mid uuid;
begin
  if public.is_admin() then
    return true;
  end if;
  if not public.is_approved() then
    return false;
  end if;
  if split_part(p, '/', 1) = 'messages' then
    begin
      mid := split_part(p, '/', 2)::uuid;
    exception when others then
      return false;
    end;
    return exists (
      select 1 from public.messages m
      where m.id = mid
        and m.attachment_path = p
        and (m.audience = 'all' or m.family_id = auth.uid())
    );
  end if;
  begin
    cid := split_part(p, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  return public.owns_child(cid);
end;
$$;

-- Write (upload): admin anywhere; parents only into their own child's folder,
-- never into messages/.
create or replace function public.can_write_path(p text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  cid uuid;
begin
  if public.is_admin() then
    return true;
  end if;
  if split_part(p, '/', 1) = 'messages' then
    return false;
  end if;
  begin
    cid := split_part(p, '/', 1)::uuid;
  exception when others then
    return false;
  end;
  return public.is_approved() and public.owns_child(cid);
end;
$$;

-- ---------- Automatic rules (triggers) --------------------------------

-- Create a profile row whenever someone signs up. Always starts unapproved.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    lower(new.email),
    left(coalesce(new.raw_user_meta_data ->> 'full_name', ''), 120)
  );
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Parents can't set the classroom or move a child to another account.
create or replace function public.children_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not public.is_admin() then
    if tg_op = 'INSERT' then
      new.classroom := null;
    else
      new.classroom := old.classroom;
      new.parent_id := old.parent_id;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists children_guard on public.children;
create trigger children_guard
  before insert or update on public.children
  for each row execute function public.children_guard();

-- Who uploaded a document, and whether it came from a parent or the
-- center, is decided here on the server, never by the browser.
create or replace function public.documents_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.uploaded_by := auth.uid();
  new.source := case when public.is_admin() then 'center' else 'parent' end;
  return new;
end;
$$;

drop trigger if exists documents_guard on public.documents;
create trigger documents_guard
  before insert on public.documents
  for each row execute function public.documents_guard();

-- Messages: who posted it is set by the server; a child must belong to the
-- family the message is sent to; attachments must live in the message's folder.
create or replace function public.messages_guard()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_at := now();
  else
    new.created_by := old.created_by;
    new.created_at := old.created_at;
  end if;
  if new.child_id is not null and not exists (
    select 1 from public.children c where c.id = new.child_id and c.parent_id = new.family_id
  ) then
    raise exception 'That child does not belong to this family.' using errcode = 'check_violation';
  end if;
  if new.attachment_path is not null
     and new.attachment_path not like 'messages/' || new.id::text || '/%' then
    raise exception 'Attachment path must be inside this message''s folder.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_guard on public.messages;
create trigger messages_guard
  before insert or update on public.messages
  for each row execute function public.messages_guard();

-- ---------- Row-level security (who can see what) ---------------------

alter table public.profiles  enable row level security;
alter table public.children  enable row level security;
alter table public.documents enable row level security;
alter table public.messages  enable row level security;

-- profiles: you see yourself; admins see and approve everyone.
-- Nobody can change their own role or approval.
drop policy if exists "profiles: read own"        on public.profiles;
drop policy if exists "profiles: admin read all"  on public.profiles;
drop policy if exists "profiles: admin update"    on public.profiles;

create policy "profiles: read own" on public.profiles
  for select to authenticated using (id = auth.uid());
create policy "profiles: admin read all" on public.profiles
  for select to authenticated using (public.is_admin());
create policy "profiles: admin update" on public.profiles
  for update to authenticated using (public.is_admin()) with check (public.is_admin());

-- children
drop policy if exists "children: parent read own"   on public.children;
drop policy if exists "children: parent insert own" on public.children;
drop policy if exists "children: parent update own" on public.children;
drop policy if exists "children: admin all"         on public.children;

create policy "children: parent read own" on public.children
  for select to authenticated
  using (parent_id = auth.uid() and public.is_approved());
create policy "children: parent insert own" on public.children
  for insert to authenticated
  with check (parent_id = auth.uid() and public.is_approved());
create policy "children: parent update own" on public.children
  for update to authenticated
  using (parent_id = auth.uid() and public.is_approved())
  with check (parent_id = auth.uid());
create policy "children: admin all" on public.children
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- documents (parents can add and view; only admins delete)
drop policy if exists "documents: parent read own"   on public.documents;
drop policy if exists "documents: parent insert own" on public.documents;
drop policy if exists "documents: admin all"         on public.documents;

create policy "documents: parent read own" on public.documents
  for select to authenticated
  using (public.is_approved() and public.owns_child(child_id));
create policy "documents: parent insert own" on public.documents
  for insert to authenticated
  with check (
    public.is_approved()
    and public.owns_child(child_id)
    and uploaded_by = auth.uid()
    and source = 'parent'
    and split_part(storage_path, '/', 1) = child_id::text
  );
create policy "documents: admin all" on public.documents
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- messages: approved parents read messages for all families or for their
-- own family. Only staff (admins) can post, edit, or delete.
drop policy if exists "messages: parent read"  on public.messages;
drop policy if exists "messages: admin all"    on public.messages;

create policy "messages: parent read" on public.messages
  for select to authenticated
  using (public.is_approved() and (audience = 'all' or family_id = auth.uid()));
create policy "messages: admin all" on public.messages
  for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

-- ---------- Private file storage --------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents', 'documents', false, 10485760,  -- 10 MB per file
  array[
    'application/pdf',
    'image/jpeg', 'image/png', 'image/heic', 'image/heif',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "files: read own family"   on storage.objects;
drop policy if exists "files: upload own family" on storage.objects;
drop policy if exists "files: admin update"      on storage.objects;
drop policy if exists "files: admin delete"      on storage.objects;

create policy "files: read own family" on storage.objects
  for select to authenticated
  using (bucket_id = 'documents' and public.can_read_path(name));
create policy "files: upload own family" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and public.can_write_path(name));
create policy "files: admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and public.is_admin());
create policy "files: admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and public.is_admin());

-- Older versions of this setup used one combined check; it's no longer needed.
drop function if exists public.can_access_path(text);

-- =====================================================================
-- Make each staff member an admin (Tina, Grace, ...).
-- They first create an account in the portal with "Request access" and
-- confirm their email. Then replace the email below and run just these lines,
-- once per staff member:
--
--   update public.profiles
--   set role = 'admin', approved = true
--   where email = lower('staff.member@example.com');
-- =====================================================================
