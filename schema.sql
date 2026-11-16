-- =====================================================================
-- Tina's Little Angels: Parent Portal database setup
-- Run ONCE in Supabase: SQL Editor > New query > paste all of this > Run.
--
-- What this sets up
--   profiles   one row per account (parent or admin), created automatically
--   children   child profiles; each parent sees and edits only their own
--   documents  file records; parents see only their own children's files
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

-- Files are stored as "<child id>/<random>-<file name>".
-- Access to a file = admin, or the approved parent who owns that child.
create or replace function public.can_access_path(p text)
returns boolean language plpgsql stable security definer set search_path = public as $$
declare
  cid uuid;
begin
  if public.is_admin() then
    return true;
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

-- ---------- Row-level security (who can see what) ---------------------

alter table public.profiles  enable row level security;
alter table public.children  enable row level security;
alter table public.documents enable row level security;

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
  using (bucket_id = 'documents' and public.can_access_path(name));
create policy "files: upload own family" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documents' and public.can_access_path(name));
create policy "files: admin update" on storage.objects
  for update to authenticated
  using (bucket_id = 'documents' and public.is_admin());
create policy "files: admin delete" on storage.objects
  for delete to authenticated
  using (bucket_id = 'documents' and public.is_admin());

-- =====================================================================
-- After Tina creates her own account in the portal, make her the admin.
-- Replace the email below with hers, then run just these lines:
--
--   update public.profiles
--   set role = 'admin', approved = true
--   where email = lower('tina@example.com');
-- =====================================================================
