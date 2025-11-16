alter table if exists public.magi_sessions
    add column if not exists live_url text;

create index if not exists magi_sessions_live_url_idx
    on public.magi_sessions using btree (live_url);
