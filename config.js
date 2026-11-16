// =====================================================================
// Portal settings: the ONLY file you need to edit.
//
// 1. In Supabase, open Project Settings > API (or "API Keys").
// 2. Paste the Project URL and the anon / publishable key below.
//    These two values are designed to be public. The privacy rules in
//    the database (schema.sql) are what keep each family's records private.
//    NEVER paste the "service_role" or "secret" key here.
//
// While the values below still say YOUR-PROJECT, the portal runs in
// DEMO MODE with made-up sample data and saves nothing.
// =====================================================================
window.PORTAL_CONFIG = {
  SUPABASE_URL: "https://YOUR-PROJECT.supabase.co",
  SUPABASE_ANON_KEY: "YOUR-ANON-OR-PUBLISHABLE-KEY",

  CENTER_NAME: "Tina’s Little Angels",
  CENTER_PHONE: "(508) 285-4012",
  CENTER_WEBSITE: "", // e.g. "https://www.tinaslittleangels.com" (shows a "Back to website" link)
  CENTER_ADDRESS: "4 Scott Drive, Norton, MA",
  LOGO_URL: "",       // e.g. "logo.png" after putting the logo file in this folder. Blank = "T" monogram.

  // Payments (optional). Both links come from Tina's own Stripe account; see SETUP.md Step 8.
  // Leave blank to hide the Payments section. Only https://...stripe.com links are accepted.
  STRIPE_BILLING_PORTAL_URL: "", // Settings > Billing > Customer portal > login link, e.g. "https://billing.stripe.com/p/login/abc123"
  STRIPE_PAYMENT_LINK: ""        // a Payment Link set to "customers choose what to pay", e.g. "https://buy.stripe.com/abc123"
};
