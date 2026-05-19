alter table if exists public.profiles
    add column if not exists usage_mode text;

alter table if exists public.profiles
    add column if not exists payment_status text;

alter table if exists public.profiles
    add column if not exists stripe_checkout_session_id text;

alter table if exists public.profiles
    add column if not exists stripe_customer_id text;

alter table if exists public.profiles
    add column if not exists stripe_subscription_id text;

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

comment on column public.profiles.stripe_customer_id
    is 'Stripe Customer ID for hosted MAGI access.';

comment on column public.profiles.stripe_subscription_id
    is 'Current Stripe Subscription ID for hosted MAGI access.';

create table if not exists public.magi_subscriptions (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    stripe_customer_id text,
    stripe_subscription_id text unique,
    stripe_checkout_session_id text unique,
    stripe_price_id text,
    status text not null default 'checkout_started',
    current_period_end timestamptz,
    cancel_at_period_end boolean not null default false,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index if not exists magi_subscriptions_user_id_idx
    on public.magi_subscriptions using btree (user_id);

create index if not exists magi_subscriptions_customer_id_idx
    on public.magi_subscriptions using btree (stripe_customer_id);

alter table public.magi_subscriptions enable row level security;

drop policy if exists "Users can view their own MAGI subscriptions" on public.magi_subscriptions;

create policy "Users can view their own MAGI subscriptions"
on public.magi_subscriptions
for select
using (auth.uid() = user_id);

create table if not exists public.magi_usage_events (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade,
    session_id uuid references public.magi_sessions(id) on delete set null,
    event_type text not null default 'hosted_run',
    created_at timestamptz not null default now()
);

create index if not exists magi_usage_events_user_created_idx
    on public.magi_usage_events using btree (user_id, created_at desc);

alter table public.magi_usage_events enable row level security;

drop policy if exists "Users can view their own MAGI usage events" on public.magi_usage_events;

create policy "Users can view their own MAGI usage events"
on public.magi_usage_events
for select
using (auth.uid() = user_id);

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
