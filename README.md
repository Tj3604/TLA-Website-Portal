# Tina's Little Angels Parent Portal (developer notes)

This is a static single-page app (`public/`) on Supabase: Auth, Postgres with row-level security, and a private Storage bucket. There's no build step and no server code, and it deploys to Cloudflare Pages as-is.

- `public/index.html`, `styles.css`, `app.js`: the UI is plain JS. All user data is rendered with `textContent`, never `innerHTML`.
- `public/config.js`: Supabase URL and anon/publishable key. Placeholders put the app in **demo mode**, which uses in-memory sample data.
- `public/vendor/supabase.js`: supabase-js 2.118.0 UMD build, served locally so there's no third-party script. Its MIT license is alongside.
- `public/_headers`: Cloudflare Pages security headers (CSP, nosniff, referrer, HSTS). Edit `frame-ancestors` to allow embedding in Wix.
- `supabase/schema.sql`: tables, triggers, RLS policies, and the storage bucket and policies. Run it once in the SQL Editor; it's idempotent.

## Security model

- `profiles.approved` gates everything. New sign-ups start unapproved, and only an admin can change `approved` or `role`, since there's no client UPDATE policy on your own profile.
- Parents get select/insert/update on `children` where `parent_id = auth.uid()`. A trigger stops parents from setting `classroom` or changing `parent_id`.
- On `documents`, parents can select and insert for children they own. A trigger forces `uploaded_by = auth.uid()` and sets `source` (`center` if admin, otherwise `parent`). The insert policy also requires `storage_path` to start with the child's id. Only admins can delete.
- Storage bucket `documents` is private, with a 10 MB limit and a MIME allow-list. Object paths are `<child_id>/<uuid>-<name>`. `can_access_path()` allows admins, or the approved owner of that child. Files are opened via 60-second signed URLs.
- Helper functions are `SECURITY DEFINER` with a pinned `search_path` and are read-only.

The RLS behaviour was verified against Postgres 16 with Supabase stand-ins: unapproved, approved, cross-family, admin, anon, and removed-access cases. See `dev/test_rls.sql` in the source folder; it isn't part of the deploy.

## Not included (by design)

- No email notifications to Tina for new sign-ups. Check the Approvals tab, or add a Supabase database webhook.
- Parents can't delete. Deletion is done by an admin in the Supabase dashboard.
- No audit log or file virus scanning.

## Payments
- Parents: "Tuition & payments" panel links to Stripe-hosted pages (no-code customer portal login link + optional Payment Link), set in `config.js` (`STRIPE_BILLING_PORTAL_URL`, `STRIPE_PAYMENT_LINK`). Only https *.stripe.com URLs are accepted.
- Admin: Families → Open → "Payments" tab (per-family, filtered by the parent's portal email) calls the Edge Function `supabase/functions/admin-payments` (Deno). It verifies the caller with `rpc('is_admin')` using the caller's JWT, then lists Stripe charges (limit 100, `expand[]=data.customer`, paging via `startingAfter`) with a restricted read-only key in the `STRIPE_RESTRICTED_KEY` secret. Keep JWT verification on.
