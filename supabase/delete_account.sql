-- Lets a signed-in user delete their own account from the app ("Delete account" in the account menu).
-- Run once in the Supabase dashboard: SQL Editor → New query → paste → Run.
-- Without it everything else works; the Delete button just reports that deletion isn't set up.
create or replace function public.delete_account()
returns void
language sql
security definer
set search_path = ''
as $$
  delete from auth.users where id = (select auth.uid());
$$;

revoke all on function public.delete_account() from public, anon;
grant execute on function public.delete_account() to authenticated;
