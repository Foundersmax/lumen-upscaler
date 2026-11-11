// Supabase project settings. Copy both values from
//   Supabase dashboard → Project Settings → API  (Project URL and the "anon" / "publishable" key)
// They are meant to be public (they ship to every visitor); access is controlled by Supabase's
// auth settings and row-level security, not by hiding them. Never put the service_role key here.
//
// While this is null, the sign-in button isn't shown and the site works exactly as before.
export const supabaseConfig = null;
/* Example:
export const supabaseConfig = {
  url: "https://abcdefghijklmnop.supabase.co",
  anonKey: "eyJhbGciOi…",
};
*/
