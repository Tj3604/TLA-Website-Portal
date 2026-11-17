# Tina's Little Angels Parent Portal: Setup Guide

This guide is for Grace and Tina. It takes about an hour, and no coding is needed. Just copy and paste where it says to. It's set up for a center of about 60 children and 50 families.

## What you're setting up

- **Supabase** holds the logins, child records, messages, and uploaded files. It's like the filing cabinet, and it has a lock on every drawer.
- **Cloudflare Pages** hosts the portal web page itself, at an address like `tinas-portal.pages.dev` or `portal.yourdomain.com`.
- **Your Wix site** gets a "Parent Portal" button that links to it.

Tina's Little Angels owns both accounts and pays for them directly.

**How privacy works:** every parent signs up, and the center has to approve them before they see anything. After that, the database itself only shows each parent their own children, their own files, and the messages meant for them (messages for all families, plus anything sent just to their family). Files are never public. Each time someone opens one, they get a link that stops working after 60 seconds.

---

## Step 1: Create the Supabase project (database)

1. Go to **supabase.com** and sign up using the center's email.
2. Click **New project**. Name it `tinas-parent-portal`. Create a strong database password and save it somewhere safe, like a password manager. Pick the **East US** region.
3. **Choose a plan.**
   - The **Free** plan works for testing.
   - Free projects **pause after a week of no activity** and have **no automatic backups**.
   - For real children's records, use **Pro (about $25/month)**, which includes daily backups. Pro easily covers 60 children, their documents, and the message board.

## Step 2: Set up the database

1. In your Supabase project, open **SQL Editor** and click **New query**.
2. Open the file `supabase/schema.sql` from this folder. Copy **everything** in it, paste it into the editor, and click **Run**.
3. You should see "Success. No rows returned." That creates the tables (including the message board), the privacy rules, and the private file storage.

If you ever get an updated `schema.sql`, run it the same way. It's safe to run again and keeps your existing data.

## Step 3: Login settings

1. Go to **Authentication → URL Configuration**.
   - Set **Site URL** to the portal's address. You'll get that address in Step 5, so come back to this.
   - Add the same address under **Redirect URLs**.
2. Go to **Authentication → Sign In / Providers → Email**. Make sure **Confirm email** is turned on.
3. **Required before inviting families: connect your own email sender.** Every parent gets a confirmation email when they sign up, and another when they reset a password. Supabase's built-in sender is only for testing and sends just a few emails per hour. With around 50 families signing up, most of those emails would never arrive.
   - Go to **Authentication → Emails → SMTP Settings** and turn on **custom SMTP**.
   - Use any email-sending service, such as Google Workspace, Microsoft 365, Resend, or Brevo. The service shows you the host, port, username, and password to paste in.
   - Set the sender to something like `portal@yourcenter.com` with the name "Tina's Little Angels."
   - Send yourself a test sign-up before inviting families.

## Step 4: Connect the portal to the database

1. In Supabase, go to **Project Settings → API Keys**. Copy:
   - The **Project URL**, which looks like `https://abcdefgh.supabase.co` (also shown on the project's home page).
   - The **publishable key** (or, on the "Legacy" tab, the **anon public** key).
2. Open `public/config.js` in a plain text editor (Notepad or TextEdit).
3. Replace `https://YOUR-PROJECT.supabase.co` and `YOUR-ANON-OR-PUBLISHABLE-KEY` with your two values. Keep the quote marks.
4. Optionally, set `CENTER_WEBSITE` to your Wix site address. This adds a "Back to website" link.

> ⚠️ **Never** paste the `service_role` or `secret` key anywhere in the portal. Those keys skip all the privacy rules.

Until `config.js` is filled in, the portal runs in **demo mode** with made-up families, and it saves nothing.

## Step 5: Put the portal online (Cloudflare)

There are two ways. **Option A is recommended**: Cloudflare rebuilds the site by itself every time a file changes on GitHub.

### Option A: Connect GitHub (automatic updates)

1. Create a free GitHub account for the center, then a **new private repository** named `tla-parent-portal`.
2. Upload **everything in this folder** to it. That's the `public` and `supabase` folders plus `wrangler.jsonc`, `package.json`, `README.md`, and `SETUP.md`. Don't upload just the `public` folder.
3. Go to **dash.cloudflare.com** and sign up (free). Open **Workers & Pages → Create**.
4. Choose whichever screen Cloudflare shows you:
   - **Workers → Import a repository** (Cloudflare's current default). Pick the repo.
     - **Build command:** leave blank.
     - **Deploy command:** `npx wrangler deploy` (usually filled in for you).
   - **Pages → Connect to Git.** Pick the repo.
     - **Framework preset:** None.
     - **Build command:** leave blank.
     - **Build output directory:** `public`.
5. Click **Deploy**. In about a minute the portal is live at the address Cloudflare shows (for example `tla-parent-portal.<name>.workers.dev` or `tla-parent-portal.pages.dev`).
6. Go back to **Step 3** and put this address in Site URL and Redirect URLs.

**To update the site later**, edit a file on GitHub (for example `public/config.js`) and click **Commit**. Cloudflare redeploys by itself.

### Option B: Drag and drop (no GitHub)

1. In Cloudflare, open **Workers & Pages → Create → Pages → Upload assets** and name the project, for example `tinas-portal`.
2. Drag in the **`public`** folder and click **Deploy**.
3. To update it, upload the `public` folder again.

### Optional: a nicer address like `portal.tinaslittleangels.com`

1. In the Cloudflare project, open **Custom domains** (for Workers: **Settings → Domains & Routes → Add → Custom domain**) and follow the steps. If the domain is managed in Wix, Cloudflare tells you which **CNAME** record to add in Wix's DNS settings.
2. Then update Step 3 with the new address.

## Step 6: Make each staff member an admin

Staff accounts (for example Tina and Grace) see the **Center dashboard** instead of the parent view. Repeat this for each staff member.

1. Open the portal and click **Request access**. Sign up with the staff member's email and confirm it from their inbox.
2. In Supabase, open **SQL Editor → New query**. Paste this, change the email, and click **Run**:

   ```sql
   update public.profiles
   set role = 'admin', approved = true
   where email = lower('staff.member@example.com');
   ```

3. Log out and back in. They now see the **Center dashboard**.

To remove someone's staff access later, run the same command with `role = 'parent'`.

## Step 7: Link it from Wix

**Easiest (recommended):** in the Wix editor, add a button or menu item called **Parent Portal** that links to the portal address and opens in a new tab.

**Show it inside a Wix page (optional):**

1. In Wix, use **Add → Embed Code → Embed a Site** and paste the portal address. Make the box tall, about 1,200 px.
2. In `public/_headers`, change the `frame-ancestors` part to include your Wix site's address. The file has an example.
3. Re-upload the `public` folder to Cloudflare.

Some browsers, especially Safari, limit logins inside embedded boxes. If parents have trouble logging in, use the button link instead.

## How it works day to day

Everything below happens in the **Center dashboard**, which every staff member sees when they log in.

- **New family:** the parent clicks **Request access**, signs up, and confirms their email. A staff member opens **Approvals** and clicks **Approve**. Only approve people you recognize.
- **Parents** add each child's info and upload forms (immunization records, physicals, enrollment packets). They can update the info any time. Only staff can set the **classroom**.

### Posting messages

Open the **Messages** tab and fill in **Post a message**. There are three types:

- **Announcement:** news such as closures, reminders, or a newsletter. Choose **All families**, or one family for something private.
- **Event:** picture day, a holiday party, and so on. Add the date, and the time if there is one. Parents see upcoming events, soonest first. Events drop off their list once the date has passed.
- **Document request:** ask one family for a form. Pick the family, and the child if it's about one child. It shows at the top of that parent's page under **Documents we need**, with an **Upload now** button.

You can attach a file to any message (a newsletter, the handbook, a form to sign). Families open it from the message.

When a family sends what you asked for, find the request in **Messages** (the **Open requests** filter helps) and click **Mark received**. It disappears from their list. **Reopen** brings it back. **Delete** removes the message and its attachment; it asks you to confirm first.

### Sending documents to a family

- **Families → Open** a family **→ Documents** shows everything for that family, both what they've uploaded and what the center has posted. Use **Post a document for this family** and pick which child it's for. Only that family will see it.
- You can also open a child (from **Children**) and post from their page.
- To send the same document to **every** family (a newsletter or handbook), post an announcement with the file attached instead.

### Finding people

- **Children** has a search box (child or parent name) and a classroom filter.
- **Families** has a search box (parent name, email, or a child's name).
- Each family page has **Children**, **Documents**, and **Messages** tabs, and a **Request a document** shortcut.

### Other things

- **A family leaves:** go to **Families → Remove access** and confirm. Their records stay saved, but they can't log in to view them.
- **Forgot password:** parents use **Forgot your password?** on the login screen.
- **Deleting child records or documents:** do this in Supabase under **Table Editor** (records) and **Storage → documents** (files). Parents can't delete anything.

## Test before real families use it

- [ ] Sign up as a fake **Parent A**. Confirm the account is stuck on "waiting for approval" until a staff member approves it.
- [ ] As Parent A, add a child, edit the child, and upload a PDF.
- [ ] Sign up as a fake **Parent B**. Confirm B **cannot** see Parent A's child or files.
- [ ] As staff, post a document to Parent A's child. Confirm only A sees it.
- [ ] As staff, post an announcement to **All families** with a file attached. Confirm both A and B see it and can open the file.
- [ ] As staff, send a **document request** to Parent A only. Confirm A sees it under **Documents we need** and B doesn't. Click **Upload now** as A, upload, then **Mark received** as staff.
- [ ] Post an event dated tomorrow. Confirm it shows under **Upcoming events**.
- [ ] Open a document, copy its address, wait 2 minutes, and paste it into a new tab. It should no longer open.
- [ ] Test **Forgot your password?** and confirm the email arrives (this checks your email sender from Step 3).
- [ ] Delete the test accounts (Supabase → **Authentication → Users**).

## What Tina's Little Angels is responsible for

- The Supabase, Cloudflare, and email-sender accounts, their passwords, and their bills. Turn on two-step login for all of them.
- Approving only real families, removing access when families leave, and giving staff access only to current staff.
- Backups (included with Supabase Pro) and keeping a copy of anything critical.
- Future changes or fixes to the portal. Support after handoff isn't included unless agreed separately.
- Deciding what's appropriate to store. Avoid Social Security numbers, and keep uploads to what the center actually needs.
