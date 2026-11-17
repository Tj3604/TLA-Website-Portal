# Tina's Little Angels Parent Portal (developer notes)

This is a static single-page app (`public/`) on Supabase: Auth, Postgres with row-level security, and a private Storage bucket. There's no build step and no server code, and it deploys to Cloudflare Pages as-is.

- `public/index.html`, `styles.css`, `app.js`: the UI is plain JS. All user data is rendered with `textContent`, never `innerHTML`.
- `public/config.js`: Supabase URL and anon/publishable key. Placeholders put the app in **demo mode**, which uses in-memory sample data.
- `public/vendor/supabase.js`: supabase-js 2.118.0 UMD build, served locally so there's no third-party script. Its MIT license is alongside.
- `public/_headers`: Cloudflare Pages security headers (CSP, nosniff, referrer, HSTS). Edit `frame-ancestors` to allow embedding in Wix.
- `supabase/schema.sql`: tables (`profiles`, `children`, `documents`, `messages`), triggers, RLS policies, and the storage bucket and policies. Run it in the SQL Editor; it's idempotent and safe to re-run on an existing project.

## Security model

- `profiles.approved` gates everything. New sign-ups start unapproved, and only an admin can change `approved` or `role`, since there's no client UPDATE policy on your own profile.
- Parents get select/insert/update on `children` where `parent_id = auth.uid()`. A trigger stops parents from setting `classroom` or changing `parent_id`.
- On `documents`, parents can select and insert for children they own. A trigger forces `uploaded_by = auth.uid()` and sets `source` (`center` if admin, otherwise `parent`). The insert policy also requires `storage_path` to start with the child's id. Only admins can delete.
- `messages` (message board): `kind` announcement/event/request; `audience` `all` or `family` (+ `family_id`, optional `child_id`). Check constraints: family audience needs `family_id`, `all` has none; events need `event_date`; requests must target one family. A trigger forces `created_by = auth.uid()`, freezes `created_by`/`created_at` on update, checks the child belongs to `family_id`, and requires `attachment_path` to be inside `messages/<id>/`. RLS: approved parents can SELECT rows where `audience = 'all'` or `family_id = auth.uid()`; only admins insert/update/delete. `status` (open/done) is for requests.
- Storage bucket `documents` is private, with a 10 MB limit and a MIME allow-list. Object paths are `<child_id>/<uuid>-<name>` or `messages/<message_id>/<uuid>-<name>`. Reads go through `can_read_path()`: admins; the approved owner of that child; or, for message attachments, an approved parent who can see that message and only for the exact `attachment_path`. Uploads go through `can_write_path()`: admins anywhere; parents only into their own child's folder, never `messages/`. Files are opened via 60-second signed URLs.
- Admin = `profiles.role = 'admin'`. Several staff accounts can be admins.
- Helper functions are `SECURITY DEFINER` with a pinned `search_path` and are read-only.

The RLS behaviour was verified against Postgres 16 with Supabase stand-ins: unapproved, approved, cross-family, admin, anon, removed-access, and message-board cases (visibility, read-only for parents, child/family consistency, event dates, attachment reads, no parent uploads into `messages/`). See `dev/test_rls.sql` in the source folder; it isn't part of the deploy.

## Not included (by design)

- No email or push notifications for new sign-ups or new messages. Staff check the Approvals tab; parents see messages when they log in. Either could be added later with a Supabase database webhook.
- No billing. The center handles billing outside the portal.
- Parents can't delete. Deletion is done by an admin in the Supabase dashboard.
- No audit log or file virus scanning.

## Deploying on Cloudflare
- Static site, no build step. Assets live in `public/`; `public/_headers` sets security headers (works on Pages and Workers static assets).
- **Workers (Git / Workers Builds):** `wrangler.jsonc` serves `./public` as static assets. Build command: none. Deploy command: `npx wrangler deploy`. Local preview: `npm install && npm run dev`. Check config: `npm run check` (`wrangler deploy --dry-run`).
- **Pages (Git):** framework preset None, build command blank, output directory `public`.
- Tested with wrangler 4.156.0: dry-run deploy passes; `wrangler dev` serves the app with the CSP/nosniff/referrer headers from `_headers`.
