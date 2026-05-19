alter table if exists public.profiles
    add column if not exists usage_mode text;

alter table if exists public.profiles
    add column if not exists payment_status text;

alter table if exists public.profiles
    add column if not exists stripe_checkout_session_id text;

alter table if exists public.profiles
    drop constraint if exists profiles_usage_mode_check;

alter table if exists public.profiles
    drop constraint if exists profiles_payment_status_check;

alter table if exists public.profiles
    add constraint profiles_usage_mode_check
    check (usage_mode is null or usage_mode in ('bring_keys', 'paid'));

alter table if exists public.profiles
    add constraint profiles_payment_status_check
    check (payment_status is null or payment_status in ('not_required', 'pay_later', 'checkout_started', 'paid'));

comment on column public.profiles.usage_mode
    is 'Selected onboarding path: bring_keys for user-supplied provider keys, paid for hosted MAGI access.';

comment on column public.profiles.payment_status
    is 'Payment state for hosted MAGI access.';

comment on column public.profiles.stripe_checkout_session_id
    is 'Most recent Stripe Checkout Session created for hosted MAGI access.';

create or replace function public.handle_new_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
    insert into public.profiles (id, email, created_at, updated_at)
    values (new.id, new.email, now(), now())
    on conflict (id) do update
        set email = excluded.email,
            updated_at = now();

    return new;
end;
$$;

drop trigger if exists on_auth_user_created_create_profile on auth.users;

create trigger on_auth_user_created_create_profile
after insert on auth.users
for each row execute function public.handle_new_user_profile();

insert into public.profiles (id, email, created_at, updated_at)
select id, email, created_at, now()
from auth.users
on conflict (id) do update
    set email = excluded.email,
        updated_at = now();

update public.profiles
set payment_status = 'not_required',
    updated_at = now()
where usage_mode = 'bring_keys'
  and payment_status is null;
