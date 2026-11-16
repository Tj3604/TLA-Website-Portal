# Tina's Little Angels Parent Portal: Setup Guide

This guide is for Grace and Tina. It takes about an hour, and no coding is needed. Just copy and paste where it says to.

## What you're setting up

- **Supabase** holds the logins, child records, and uploaded files. It's like the filing cabinet, and it has a lock on every drawer.
- **Cloudflare Pages** hosts the portal web page itself, at an address like `tinas-portal.pages.dev` or `portal.yourdomain.com`.
- **Your Wix site** gets a "Parent Portal" button that links to it.

Tina's Little Angels owns both accounts and pays for them directly.

**How privacy works:** every parent signs up, and Tina has to approve them before they see anything. After that, the database itself only shows each parent their own children and files. Files are never public. Each time someone opens one, they get a link that stops working after 60 seconds.

---

## Step 1: Create the Supabase project (database)

1. Go to **supabase.com** and sign up using the center's email.
2. Click **New project**. Name it `tinas-parent-portal`. Create a strong database password and save it somewhere safe, like a password manager. Pick the **East US** region.
3. **Choose a plan.**
   - The **Free** plan works for testing.
   - Free projects **pause after a week of no activity** and have **no automatic backups**.
   - For real children's records, use **Pro (about $25/month)**, which includes daily backups.

## Step 2: Set up the database

1. In your Supabase project, open **SQL Editor** and click **New query**.
2. Open the file `supabase/schema.sql` from this folder. Copy **everything** in it, paste it into the editor, and click **Run**.
3. You should see "Success. No rows returned." That creates the tables, the privacy rules, and the private file storage.

## Step 3: Login settings

1. Go to **Authentication → URL Configuration**.
   - Set **Site URL** to the portal's address. You'll get that address in Step 5, so come back to this.
   - Add the same address under **Redirect URLs**.
2. Go to **Authentication → Sign In / Providers → Email**. Make sure **Confirm email** is turned on.
3. **Recommended: connect your own email sender.** Supabase's built-in sender is meant for testing and only sends a few emails per hour.
   - Go to **Authentication → Emails → SMTP Settings** and connect an email service, such as Google Workspace or a service like Resend.
   - This way sign-up and password reset emails reliably arrive from your center.

## Step 4: Connect the portal to the database

1. In Supabase, go to **Project Settings → API Keys**. Copy:
   - The **Project URL**, which looks like `https://abcdefgh.supabase.co` (also shown on the project's home page).
   - The **publishable key** (or, on the "Legacy" tab, the **anon public** key).
2. Open `public/config.js` in a plain text editor (Notepad or TextEdit).
3. Replace `https://YOUR-PROJECT.supabase.co` and `YOUR-ANON-OR-PUBLISHABLE-KEY` with your two values. Keep the quote marks.
4. Optionally, set `CENTER_WEBSITE` to your Wix site address. This adds a "Back to website" link.

> ⚠️ **Never** paste the `service_role` or `secret` key anywhere in the portal. Those keys skip all the privacy rules.

Until `config.js` is filled in, the portal runs in **demo mode** with made-up families, and it saves nothing.

## Step 5: Put the portal online (Cloudflare Pages)

1. Go to **dash.cloudflare.com** and sign up (free).
2. Open **Workers & Pages → Create → Pages → Upload assets**.
3. Name the project, for example `tinas-portal`.
4. Drag in the whole **`public`** folder and click **Deploy**.
5. Your portal is now live at `https://tinas-portal.pages.dev` (the address shown).
6. Go back to **Step 3** and put this address in Site URL and Redirect URLs.

**Optional, a nicer address** like `portal.tinaslittleangels.com`:

1. In the Cloudflare Pages project, go to **Custom domains → Set up a domain** and follow the steps. If your domain is managed in Wix, you'll add a **CNAME** record in Wix's DNS settings pointing to your `.pages.dev` address.
2. Then update Step 3 with the new address.

**Whenever you change a file**, such as `config.js`, upload the `public` folder again to update the site.

## Step 6: Make Tina the admin

1. Open the portal and click **Request access**. Sign up with Tina's email and confirm it from her inbox.
2. In Supabase, open **SQL Editor → New query**. Paste this, change the email to Tina's, and click **Run**:

   ```sql
   update public.profiles
   set role = 'admin', approved = true
   where email = lower('tina@example.com');
   ```

3. Log out and back in. Tina now sees **Tina's dashboard**.

## Step 7: Link it from Wix

**Easiest (recommended):** in the Wix editor, add a button or menu item called **Parent Portal** that links to the portal address and opens in a new tab.

**Show it inside a Wix page (optional):**

1. In Wix, use **Add → Embed Code → Embed a Site** and paste the portal address. Make the box tall, about 1,200 px.
2. In `public/_headers`, change the `frame-ancestors` part to include your Wix site's address. The file has an example.
3. Re-upload the `public` folder to Cloudflare.

Some browsers, especially Safari, limit logins inside embedded boxes. If parents have trouble logging in, use the button link instead.

## Step 8: Set up tuition payments (Stripe)

Parents pay on Stripe's own secure pages. The portal only links to them, so no card or bank details ever pass through the portal or the database.

1. **Create a Stripe account** at **stripe.com** in the center's name, and connect the center's bank account for payouts.
2. **Add each family as a customer.** Go to **Customers → Add customer**. Use the **same email the parent logs into the portal with**. That's how Stripe knows who they are.
3. **Bill them.** Pick one:
   - **Autopay tuition:** create a subscription for each family (for example, weekly or monthly tuition). Stripe charges them automatically.
   - **Invoices:** send invoices when tuition is due. Parents get an email and can pay online.
4. **Turn on bank payments (ACH).** Under **Settings → Payment methods**, turn on **ACH Direct Debit**. For tuition-sized amounts, bank payments cost far less than cards.
5. **Get the "Pay tuition & view bills" link.** Go to **Settings → Billing → Customer portal**, click **Activate link**, and choose what parents can do: pay invoices, update their card or bank, and see past payments. Copy the login link (it starts with `https://billing.stripe.com/p/login/`).
6. **Optional: one-time payment link** for registration fees, late pickup, field trips, and so on. Go to **Payment Links → New**, choose **Customers choose what to pay**, and copy the link (it starts with `https://buy.stripe.com/`).
7. Paste both links into `public/config.js` next to `STRIPE_BILLING_PORTAL_URL` and `STRIPE_PAYMENT_LINK`, then upload the `public` folder to Cloudflare again.
8. **Brand it.** Under **Settings → Branding**, add the logo and colors so Stripe's pages match the site.

**What parents see:** a **Tuition & payments** box on their portal home page. **Pay tuition & view bills** opens Stripe, where they enter their email and get a one-time sign-in link. **Make a one-time payment** opens a Stripe checkout page.

**Fees (charged by Stripe, taken out of each payment):** about 2.9% + 30¢ for cards, and about 0.8% (capped at $5) for bank payments. Stripe also takes a small extra cut for subscriptions and invoices. Check **stripe.com/pricing** for current rates.

## Step 9: Let Tina see payments in the portal

This adds a **Payments** tab to each family's page. In Tina's dashboard she opens **Families**, clicks **Open** on a family, and switches to **Payments**. It lists that family's payments with the date, amount, what it was for, how they paid, and whether it went through (Paid, Processing, Failed, or Refunded). Everything also shows up in Stripe's own dashboard and phone app. This tab just puts it next to the rest of the family's info.

1. **Make a read-only Stripe key.** In Stripe, go to **Developers → API keys → Create restricted key**. Name it `Parent portal (read-only)`. Set **Charges** to **Read** and **Customers** to **Read**, and leave everything else as **None**. Create it and copy the key (it starts with `rk_live_`).
2. **Store it in Supabase, not in the website.** In Supabase, go to **Edge Functions → Secrets**, click **Add new secret**, name it `STRIPE_RESTRICTED_KEY`, and paste the key.
3. **Add the payments function.** In Supabase, go to **Edge Functions → Deploy a new function → Via Editor**. Name it exactly `admin-payments`. Delete the sample code, paste in everything from `supabase/functions/admin-payments/index.ts`, and click **Deploy**. Leave **Verify JWT** turned on.
4. **Check it.** Log in to the portal as Tina, open **Families**, click **Open** on a family, and choose the **Payments** tab.

> ⚠️ This key goes **only** in Supabase's Secrets. Never put any Stripe key in `config.js`. The function checks that the person asking is Tina (the admin) before it shows anything, and the key can only *read* payments. It can't charge, refund, or change anything.

Families are matched by email. A payment shows the parent's name when the email in Stripe matches the email they use for the portal. Refunds and bill changes are still done in the Stripe dashboard.

## How it works day to day

- **New family:** the parent clicks **Request access**, signs up, and confirms their email. Tina opens **Approvals** and clicks **Approve**. Only approve people you recognize.
- **Parents** add each child's info and upload forms (immunization records, physicals, enrollment packets). They can update the info any time. Only Tina can set the **classroom**.
- **Tina** opens **Children**, picks a child, and uses **Post a document for this family**. Only that family will see it.
- **A family leaves:** go to **Families → Remove access**. Their records stay saved, but they can't log in to view them.
- **Forgot password:** parents use **Forgot your password?** on the login screen.
- **Deleting files or records:** do this in Supabase under **Table Editor** (records) and **Storage → documents** (files). Parents can't delete anything.

## Test before real families use it

- [ ] Sign up as fake **Parent A**. Confirm the account is stuck on "waiting for approval" until Tina approves it.
- [ ] As Parent A, add a child, edit the child, and upload a PDF.
- [ ] Sign up as fake **Parent B**. Confirm B **cannot** see Parent A's child or files.
- [ ] As Tina, post a document to Parent A's child. Confirm only A sees it.
- [ ] Open a document, copy its address, wait 2 minutes, and paste it into a new tab. It should no longer open.
- [ ] Test **Forgot your password?**
- [ ] Delete the test accounts (Supabase → **Authentication → Users**).

## What Tina's Little Angels is responsible for

- The Supabase and Cloudflare accounts, their passwords, and their bills. Turn on two-step login for both.
- Approving only real families, and removing access when families leave.
- Backups (included with Supabase Pro) and keeping a copy of anything critical.
- Future changes or fixes to the portal. Support after handoff isn't included unless agreed separately.
- Deciding what's appropriate to store. Avoid Social Security numbers, and keep uploads to what the center actually needs.
